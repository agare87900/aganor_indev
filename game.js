// game-test - Web Edition
// voxel game in WebGL using Three.js

console.log('game.js loaded');

// Debug helpers per chunk
const meshDebugHelpers = new Map();

// Fallback deterministic value-noise implementation when SimplexNoise
// from CDN is blocked (Tracking Prevention). This provides noise2D(x,y)
// returning values in approximately -1..1 so existing code continues
// to work unchanged.
if (typeof SimplexNoise === 'undefined') {
    globalThis.SimplexNoise = class SimplexNoise {
        constructor(seed = 0) {
            this.seed = seed | 0;
        }

        // Small integer hashing function producing 0..1
        _hash(i, j) {
            let n = i * 374761393 + j * 668265263 + (this.seed << 1);
            n = (n ^ (n >>> 13)) * 1274126177;
            return (n & 0x7fffffff) / 0x7fffffff;
        }

        // Smooth value noise based on bilinear interpolation; returns roughly -1..1
        noise2D(x, y) {
            const xi = Math.floor(x);
            const yi = Math.floor(y);
            const tx = x - xi;
            const ty = y - yi;

            const v00 = this._hash(xi, yi);
            const v10 = this._hash(xi + 1, yi);
            const v01 = this._hash(xi, yi + 1);
            const v11 = this._hash(xi + 1, yi + 1);

            const lerp = (a, b, t) => a + (b - a) * t;
            const nx0 = lerp(v00, v10, tx);
            const nx1 = lerp(v01, v11, tx);
            const n = lerp(nx0, nx1, ty);

            return n * 2 - 1;
        }
    };
}

class VoxelWorld {
    constructor(worldType = 'default') {
        this.worldType = worldType; // 'default' | 'flat' | 'islands' | 'fortress' | 'astral'
        this.chunks = new Map();
        this.chunkSize = 16;
        this.chunkHeight = 128;
        this.tileSize = 1.0; // 1.0 = each voxel is 1.0 units
        this.maxLightLevel = 15; // Skylight/block-light max
        this.sunlightFactor = 1.0; // Scales skylight by time-of-day
        this.ambientMinimum = 0.25; // Fallback ambient brightness (brighter daytime)
        // Use fixed seed so all clients generate identical terrain
        this.noise = new SimplexNoise(42);
        // Slightly larger scale and lower max height to reduce mountainous terrain
        this.terrainScale = 0.06;
        this.maxHeight = 40;
        this.waterLevel = 30;

        // Biome noise for assigning regions: forest, desert, snowy
        this.biomeNoise = new SimplexNoise(1337);

        // Astral dimension should feel bright and airy
        if (this.worldType === 'astral') {
            this.sunlightFactor = 1.5;
            this.ambientMinimum = 0.45;
        }
    }

    getTerrainHeight(x, z) {
        // Flat world: constant baseline with 25 stone, 3 dirt, 1 grass
        if (this.worldType === 'flat') {
            return 30; // height produces 25 stone (height-5), 3 dirt, 1 grass
        }

        // Islands: use radial falloff to create island shapes
        if (this.worldType === 'islands') {
            const nx = x * this.terrainScale * 0.8;
            const nz = z * this.terrainScale * 0.8;
            let height = this.noise.noise2D(nx, nz) * 0.6 + 0.4; // bias up a bit

            // Apply radial falloff from world origin to create islands
            const dist = Math.hypot(x, z);
            const falloff = Math.max(0, 1 - (dist / 200));
            height = height * falloff;

            return Math.floor(height * this.maxHeight * 0.8) + 8;
        }

        // Astral: floating islands stay higher in the sky
        if (this.worldType === 'astral') {
            const islandNoise = this.noise.noise2D(x * 0.08, z * 0.08);
            if (islandNoise < 0.2) return 0; // no island here
            const heightNoise = this.noise.noise2D(x * 0.05 + 120, z * 0.05 - 120);
            const top = 70 + Math.floor(heightNoise * 12 + 18); // cluster around y=70-100
            return top;
        }

        // Default (original) terrain with gentler hills
        const nx = x * this.terrainScale;
        const nz = z * this.terrainScale;
        // Reduce amplitude for gentler hills
        const height = this.noise.noise2D(nx, nz) * 0.35 + 0.65; // bias upward, smaller variation
        return Math.floor(height * this.maxHeight) + 15; // lower baseline to flatten overall
    }

    getBiome(x, z) {
        // Use higher-frequency noise to create more varied biome regions
        const n = this.biomeNoise.noise2D(x * 0.015, z * 0.015); // -1..1
        if (n < -0.25) return 'desert';
        if (n > 0.35) return 'snowy_forest';
        return 'forest';
    }

    getChunkKey(cx, cz) {
        return `${cx},${cz}`;
    }

    getChunk(cx, cz) {
        const key = this.getChunkKey(cx, cz);
        if (!this.chunks.has(key)) {
            const newChunk = this.generateChunk(cx, cz);
            this.chunks.set(key, newChunk);
            // Compute initial lighting for the newly generated chunk
            this.computeLightingForChunk(cx, cz);
        }
        return this.chunks.get(key);
    }

    generateChunk(cx, cz) {
        const chunk = {
            cx, cz,
            blocks: new Uint8Array(this.chunkSize * this.chunkHeight * this.chunkSize),
            skyLight: new Uint8Array(this.chunkSize * this.chunkHeight * this.chunkSize),
            blockLight: new Uint8Array(this.chunkSize * this.chunkHeight * this.chunkSize),
            modified: true
        };

        // Fairia dimension: grim stone roof, grim stone and lava underground
        if (this.worldType === 'fairia') {
            // Grim stone roof at y = chunkHeight-1
            for (let x = 0; x < this.chunkSize; x++) {
                for (let z = 0; z < this.chunkSize; z++) {
                    chunk.blocks[this.getBlockIndex(x, this.chunkHeight-1, z)] = 33; // Grim Stone roof
                }
            }
            // Terrain and underground
            for (let x = 0; x < this.chunkSize; x++) {
                for (let z = 0; z < this.chunkSize; z++) {
                    const worldX = cx * this.chunkSize + x;
                    const worldZ = cz * this.chunkSize + z;
                    const height = this.getTerrainHeight(worldX, worldZ);
                    for (let y = 0; y < this.chunkHeight-1; y++) {
                        const idx = this.getBlockIndex(x, y, z);
                        if (y === this.chunkHeight-2) {
                            chunk.blocks[idx] = 33; // Grim Stone just below roof
                        } else if (y > height) {
                            chunk.blocks[idx] = 0; // Air
                        } else if (y > height - 2) {
                            chunk.blocks[idx] = 1; // Dirt
                        } else if (y > height - 5) {
                            chunk.blocks[idx] = 3; // Stone
                        } else if (y > 10) {
                            // Mix grim stone and stone
                            chunk.blocks[idx] = (this.noise.noise2D(worldX * 0.1, worldZ * 0.1 + y) > 0.2) ? 33 : 3;
                        } else {
                            // Lava pools below y=10
                            chunk.blocks[idx] = (this.noise.noise2D(worldX * 0.2, worldZ * 0.2 + y) > 0.1) ? 34 : 33;
                        }
                    }
                }
            }
            return chunk;
        }
        // Astral dimension: floating islands in the sky with air beneath
        if (this.worldType === 'astral') {
            // Cathedral platform dimensions (needs to be placed first)
            const cathedralPlatformMinX = -20;
            const cathedralPlatformMaxX = 20;
            const cathedralPlatformMinZ = -20;
            const cathedralPlatformMaxZ = 20;
            const cathedralPlatformY = 74; // Base of platform
            
            // Cathedral building dimensions (smaller, sits on platform)
            const cathedralMinX = -15;
            const cathedralMaxX = 15;
            const cathedralMinZ = -15;
            const cathedralMaxZ = 15;
            
            for (let x = 0; x < this.chunkSize; x++) {
                for (let z = 0; z < this.chunkSize; z++) {
                    // Keep a thin bedrock layer at the bottom for safety
                    chunk.blocks[this.getBlockIndex(x, 0, z)] = 3;
                    chunk.blocks[this.getBlockIndex(x, 1, z)] = 3;

                    const worldX = cx * this.chunkSize + x;
                    const worldZ = cz * this.chunkSize + z;
                    
                    // Create solid platform for cathedral at origin
                    if (worldX >= cathedralPlatformMinX && worldX <= cathedralPlatformMaxX && 
                        worldZ >= cathedralPlatformMinZ && worldZ <= cathedralPlatformMaxZ) {
                        // Build cathedral platform (10 blocks thick)
                        for (let y = cathedralPlatformY - 10; y <= cathedralPlatformY; y++) {
                            const idx = this.getBlockIndex(x, y, z);
                            if (y === cathedralPlatformY) {
                                chunk.blocks[idx] = 2; // Grass top
                            } else if (y >= cathedralPlatformY - 2) {
                                chunk.blocks[idx] = 1; // Dirt layer
                            } else {
                                chunk.blocks[idx] = 3; // Stone base
                            }
                        }
                        continue; // Skip normal island generation for cathedral area
                    }
                    
                    const islandNoise = this.noise.noise2D(worldX * 0.04, worldZ * 0.04);
                    if (islandNoise < 0.1) continue; // Mostly empty sky

                    const heightNoise = this.noise.noise2D(worldX * 0.05 + 120, worldZ * 0.05 - 120);
                    const topY = 70 + Math.floor(heightNoise * 12 + 18); // ~70-100 range
                    const thickness = 8 + Math.floor((islandNoise + 1) * 5); // 8-18 blocks thick
                    const startY = Math.max(2, topY - thickness);
                    const endY = Math.min(this.chunkHeight - 1, topY);

                    for (let y = startY; y <= endY; y++) {
                        const idx = this.getBlockIndex(x, y, z);
                        if (y === endY) {
                            chunk.blocks[idx] = 2; // Grass on the very top
                        } else if (y >= endY - 2) {
                            chunk.blocks[idx] = 1; // Dirt near surface
                        } else {
                            chunk.blocks[idx] = 3; // Stone core
                        }
                    }
                }
            }

            // Cathedral structure (using platform variables)
            const cathedralFloorY = 75;
            const cathedralRoofY = 95;

            for (let x = 0; x < this.chunkSize; x++) {
                for (let z = 0; z < this.chunkSize; z++) {
                    const worldX = cx * this.chunkSize + x;
                    const worldZ = cz * this.chunkSize + z;

                    if (worldX >= cathedralMinX && worldX <= cathedralMaxX && worldZ >= cathedralMinZ && worldZ <= cathedralMaxZ) {
                        // Cathedral structure
                        for (let y = cathedralFloorY; y <= cathedralRoofY; y++) {
                            const idx = this.getBlockIndex(x, y, z);
                            
                            // Floor
                            if (y === cathedralFloorY) {
                                chunk.blocks[idx] = 7; // Brick floor
                                continue;
                            }

                            // Roof
                            if (y === cathedralRoofY) {
                                chunk.blocks[idx] = 7; // Brick roof
                                continue;
                            }

                            // Walls (outer perimeter)
                            if (worldX === cathedralMinX || worldX === cathedralMaxX || worldZ === cathedralMinZ || worldZ === cathedralMaxZ) {
                                // Leave entrance on north side (minZ) centered at x=0
                                if (worldZ === cathedralMinZ && worldX >= -3 && worldX <= 3 && y <= cathedralFloorY + 5) {
                                    chunk.blocks[idx] = 0; // Door opening
                                } else {
                                    chunk.blocks[idx] = 7; // Brick walls
                                }
                                continue;
                            }

                            // Plank pews - rows of planks facing the podium
                            const relX = worldX;
                            const relZ = worldZ;
                            // Pews in rows, leaving center aisle at x=0
                            if (y === cathedralFloorY + 1 && relZ >= -10 && relZ <= 5) {
                                // Left pews (x: -12 to -4)
                                if (relX >= -12 && relX <= -4 && relZ % 3 === 0) {
                                    chunk.blocks[idx] = 13; // Plank pews
                                    continue;
                                }
                                // Right pews (x: 4 to 12)
                                if (relX >= 4 && relX <= 12 && relZ % 3 === 0) {
                                    chunk.blocks[idx] = 13; // Plank pews
                                    continue;
                                }
                            }

                            // Brick podium at the south end (maxZ side)
                            if (relZ >= 10 && relZ <= 13 && Math.abs(relX) <= 5 && y <= cathedralFloorY + 2) {
                                chunk.blocks[idx] = 7; // Brick podium
                                continue;
                            }

                            // Torches at the four corners
                            if (y === cathedralFloorY + 2) {
                                if ((worldX === cathedralMinX + 1 && worldZ === cathedralMinZ + 1) ||
                                    (worldX === cathedralMaxX - 1 && worldZ === cathedralMinZ + 1) ||
                                    (worldX === cathedralMinX + 1 && worldZ === cathedralMaxZ - 1) ||
                                    (worldX === cathedralMaxX - 1 && worldZ === cathedralMaxZ - 1)) {
                                    chunk.blocks[idx] = 25; // Torch
                                    continue;
                                }
                            }

                            // Interior is air
                            chunk.blocks[idx] = 0;
                        }
                    }
                }
            }

            return chunk;
        }
        let dungeonEntryHeight = null;
        // Generate terrain
        for (let x = 0; x < this.chunkSize; x++) {
            for (let z = 0; z < this.chunkSize; z++) {
                const worldX = cx * this.chunkSize + x;
                const worldZ = cz * this.chunkSize + z;

                // Fortress mode: construct a 64x64x64 stone cube centered at origin
                if (this.worldType === 'fortress') {
                    for (let y = 0; y < this.chunkHeight; y++) {
                        const worldY = y;
                        // Cube bounds: from -32..31 in X and Z, and 0..63 in Y
                        if (worldX >= -32 && worldX < 32 && worldZ >= -32 && worldZ < 32 && worldY >= 0 && worldY < 64) {
                            // Fill with stone
                            chunk.blocks[this.getBlockIndex(x, y, z)] = 3; // Stone
                        } else {
                            // outside fortress is air
                            chunk.blocks[this.getBlockIndex(x, y, z)] = 0;
                        }
                    }
                    continue;
                }

                const height = this.getTerrainHeight(worldX, worldZ);
                if (worldX === 0 && worldZ === 0) dungeonEntryHeight = height;
                const biome = (this.worldType === 'default') ? this.getBiome(worldX, worldZ) : 'forest';

                for (let y = 0; y < this.chunkHeight; y++) {
                    const worldY = y;

                    // Bedrock
                    if (worldY < 2) {
                        chunk.blocks[this.getBlockIndex(x, y, z)] = 3; // Bedrock
                        continue;
                    }

                    // Solid stone deep below surface
                    if (worldY < height - 3) {
                        // Coal ore spawns randomly in stone (45% chance)
                        const oreNoise = this.noise.noise2D(worldX * 0.1 + worldY, worldZ * 0.1 + worldY);
                        const r = (oreNoise + 1) / 2; // Convert -1..1 to 0..1
                        
                        // Grim Stone appears deeper (below y=15)
                        if (worldY < 15) {
                            chunk.blocks[this.getBlockIndex(x, y, z)] = 33; // Grim Stone
                        } else if (r < 0.08) {
                            // Lava pockets underground (below y=15)
                            chunk.blocks[this.getBlockIndex(x, y, z)] = 34; // Lava
                        } else if (r < 0.45) {
                            chunk.blocks[this.getBlockIndex(x, y, z)] = 24; // Coal
                        } else {
                            chunk.blocks[this.getBlockIndex(x, y, z)] = 3; // Stone
                        }
                        continue;
                    }

                    // Surface/sub-surface layers (vary by biome)
                    if (worldY < height) {
                        if (biome === 'desert') {
                            // Desert: mostly sand to a few layers
                            if (worldY >= height - 3) chunk.blocks[this.getBlockIndex(x, y, z)] = 4; // Sand
                            else chunk.blocks[this.getBlockIndex(x, y, z)] = 3; // Stone beneath
                        } else if (biome === 'snowy_forest') {
                            // Snowy forest: dirt under snow cap
                            chunk.blocks[this.getBlockIndex(x, y, z)] = 1; // Dirt
                        } else {
                            // Forest/others: normal dirt; shoreline handling near water
                            if ((this.worldType === 'default' || this.worldType === 'islands') && height <= this.waterLevel + 1) {
                                if (worldY >= height - 1) chunk.blocks[this.getBlockIndex(x, y, z)] = 4; // Sand
                                else if (worldY >= height - 4) chunk.blocks[this.getBlockIndex(x, y, z)] = 9; // Clay
                                else chunk.blocks[this.getBlockIndex(x, y, z)] = 1; // Dirt
                            } else {
                                chunk.blocks[this.getBlockIndex(x, y, z)] = 1; // Dirt
                            }
                        }
                        continue;
                    }

                    // Surface block (top) varies by biome
                    if (worldY === height) {
                        if (biome === 'desert') {
                            chunk.blocks[this.getBlockIndex(x, y, z)] = 4; // Sand
                        } else if (biome === 'snowy_forest') {
                            // Use grass with a snowy cap: map to grass for now; could add snow block type if available
                            chunk.blocks[this.getBlockIndex(x, y, z)] = 2; // Grass
                        } else {
                            if ((this.worldType === 'default' || this.worldType === 'islands') && height <= this.waterLevel + 1) {
                                chunk.blocks[this.getBlockIndex(x, y, z)] = 4; // Sand near water
                            } else {
                                chunk.blocks[this.getBlockIndex(x, y, z)] = 2; // Grass
                            }
                        }
                        continue;
                    }

                    // Water and underwater areas (leave water blocks intact)
                    if (worldY < this.waterLevel) {
                        // In snowy biomes, consider icy water (if we had an ice block). For now, keep water.
                        chunk.blocks[this.getBlockIndex(x, y, z)] = 5; // Water
                        continue;
                    }
                }

                // Tree placement after column generated
                if ((biome === 'forest' || biome === 'snowy_forest') && height > this.waterLevel + 1) {
                    // Use seeded noise for deterministic tree placement across clients
                    const treeNoise = this.noise.noise2D(worldX * 0.3, worldZ * 0.3);
                    const r = (treeNoise + 1) / 2; // Convert -1..1 to 0..1
                    if (r < 0.08) {
                        // Place a trunk of wood (block 6) and a leaf canopy using leafs (block 11)
                        const trunkHeight = 4 + Math.floor(Math.abs(this.noise.noise2D(worldX * 0.5, worldZ * 0.5)) * 2); // 4-5 blocks
                        
                        // Wood trunk
                        for (let ty = 0; ty < trunkHeight; ty++) {
                            const wy = height + ty + 1; // start above surface
                            if (wy < this.chunkHeight) {
                                chunk.blocks[this.getBlockIndex(x, wy, z)] = 6; // Wood
                            }
                        }
                        
                        // Leaf canopy (2-3 blocks tall)
                        const topY = height + trunkHeight + 1;
                        const leafHeight = 2 + Math.floor(Math.abs(this.noise.noise2D(worldX * 0.7, worldZ * 0.7)) * 1.5);
                        
                        for (let ly = 0; ly < leafHeight; ly++) {
                            const canopyY = topY + ly;
                            // Leaf radius decreases toward top
                            const leafRadius = ly === leafHeight - 1 ? 1 : 2;
                            
                            for (let lx = -leafRadius; lx <= leafRadius; lx++) {
                                for (let lz = -leafRadius; lz <= leafRadius; lz++) {
                                    // Spherical shape roughly
                                    const dist = Math.sqrt(lx * lx + lz * lz);
                                    if (dist > leafRadius + 0.5) continue;
                                    
                                    const ax = x + lx;
                                    const az = z + lz;
                                    
                                    // Within chunk bounds and not overwriting trunk
                                    if (ax >= 0 && ax < this.chunkSize && az >= 0 && az < this.chunkSize && canopyY < this.chunkHeight) {
                                        if (!(lx === 0 && lz === 0 && ly === 0)) {
                                            chunk.blocks[this.getBlockIndex(ax, canopyY, az)] = 11; // Leafs
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Carve dungeon/maze near spawn
        this.carveDungeonInChunk(chunk, cx, cz, dungeonEntryHeight !== null ? dungeonEntryHeight : this.getTerrainHeight(0, 0));

        return chunk;
    }

    carveDungeonInChunk(chunk, cx, cz, surfaceHeightAtEntry) {
        // Dungeon footprint: x,z in [-16,15], floor y=19, corridors at y=20..22, ceiling y=23, room at y=19..21
        const minX = -16, maxX = 15;
        const minZ = -16, maxZ = 15;
        const floorY = 19;
        const ceilingY = 23;
        const roomY = 19;

        const worldYStartShaft = surfaceHeightAtEntry + 3; // start a bit above ground
        const shaftHalf = 0; // 1x1 shaft

        // Pick a random corner for the room
        const corners = [
            { x: -12, z: -12 }, // southwest
            { x: -12, z: 11 },  // northwest
            { x: 11, z: -12 },  // southeast
            { x: 11, z: 11 }    // northeast
        ];
        const noiseVal = (this.noise.noise2D(cx * 7.3, cz * 8.1) + 1) * 0.5; // map -1..1 to 0..1
        const cornerIndex = Math.floor(noiseVal * corners.length) % corners.length;
        const roomCorner = corners[cornerIndex];
        const roomCenterX = roomCorner.x;
        const roomCenterZ = roomCorner.z;

        for (let x = 0; x < this.chunkSize; x++) {
            for (let z = 0; z < this.chunkSize; z++) {
                const worldX = cx * this.chunkSize + x;
                const worldZ = cz * this.chunkSize + z;

                // Skip if outside footprint and not the shaft
                const inFootprint = worldX >= minX && worldX <= maxX && worldZ >= minZ && worldZ <= maxZ;
                const inShaft = Math.abs(worldX) <= shaftHalf && Math.abs(worldZ) <= shaftHalf;
                if (!inFootprint && !inShaft) continue;

                for (let y = 0; y < this.chunkHeight; y++) {
                    const idx = this.getBlockIndex(x, y, z);
                    const worldY = y;

                    // Entrance shaft from surface down to corridor top so it always meets the maze
                    if (inShaft && worldY <= worldYStartShaft && worldY >= floorY + 1) {
                        chunk.blocks[idx] = 0; // air
                        chunk.modified = true;
                        chunk.playerModified = true;
                        continue;
                    }

                    if (!inFootprint) continue;

                    // Stairs/walkway connecting maze to room
                    const toRoomX = worldX - roomCenterX;
                    const toRoomZ = worldZ - roomCenterZ;
                    const distToRoom = Math.sqrt(toRoomX * toRoomX + toRoomZ * toRoomZ);
                    const inStair = distToRoom >= 5 && distToRoom <= 8 && Math.abs(toRoomX) <= 1 && Math.abs(toRoomZ) <= 8;
                    if (inStair) {
                        const stairFloor = floorY; // keep stairs level to meet room floor cleanly
                        if (worldY === stairFloor) {
                            chunk.blocks[idx] = 3; // walkway/step surface
                            chunk.modified = true;
                            chunk.playerModified = true;
                            continue;
                        }
                        if (worldY > stairFloor && worldY < ceilingY) {
                            chunk.blocks[idx] = 0; // air above steps
                            chunk.modified = true;
                            chunk.playerModified = true;
                            continue;
                        }
                        // keep stone below the walkway for support
                        if (worldY < stairFloor) {
                            chunk.blocks[idx] = 3;
                            continue;
                        }
                    }

                    // Base floor and ceiling
                    if (worldY === floorY) {
                        chunk.blocks[idx] = 3; // stone floor
                        continue;
                    }
                    if (worldY === ceilingY) {
                        chunk.blocks[idx] = 3; // stone ceiling
                        continue;
                    }

                    // Room carving at random corner
                    const roomDx = worldX - roomCenterX;
                    const roomDz = worldZ - roomCenterZ;
                    const inRoom = Math.abs(roomDx) <= 4 && Math.abs(roomDz) <= 4 && worldY >= roomY && worldY <= roomY + 2;
                    if (inRoom) {
                        if (worldY === roomY) {
                            chunk.blocks[idx] = 3; // stone floor
                        } else {
                            // Place a chest at room center on floor+1
                            if (roomDx === 0 && roomDz === 0 && worldY === roomY + 1) {
                                chunk.blocks[idx] = 26; // chest block
                            } else {
                                chunk.blocks[idx] = 0; // air
                            }
                        }
                        chunk.modified = true;
                        chunk.playerModified = true;
                        continue;
                    }

                    // Maze corridors at y=20..22 (air), walls elsewhere remain stone
                    if (worldY > floorY && worldY < ceilingY) {
                        // Grid maze: 3-wide corridors on 7-block grid with noise variation
                        const gx = ((worldX % 7) + 7) % 7;
                        const gz = ((worldZ % 7) + 7) % 7;
                        const n = this.noise.noise2D(worldX * 0.25, worldZ * 0.25);
                        // Carve 3-wide corridors: center (0) and ±1 from grid lines
                        const carve = (gx <= 1 || gx >= 6) || (gz <= 1 || gz >= 6) || n > 0.35;
                        if (carve) {
                            chunk.blocks[idx] = 0; // corridor air
                            chunk.modified = true;
                            chunk.playerModified = true;

                        }
                    }
                }
            }
        }
    }

    getBlockIndex(x, y, z) {
        return y * this.chunkSize * this.chunkSize + z * this.chunkSize + x;
    }

    getLightIndex(x, y, z) {
        return y * this.chunkSize * this.chunkSize + z * this.chunkSize + x;
    }

    getBlock(wx, wy, wz) {
        if (wy < 0 || wy >= this.chunkHeight) return 0; // Out of bounds = air

        const cx = Math.floor(wx / this.chunkSize);
        const cz = Math.floor(wz / this.chunkSize);
        const lx = ((wx % this.chunkSize) + this.chunkSize) % this.chunkSize;
        const lz = ((wz % this.chunkSize) + this.chunkSize) % this.chunkSize;

        const chunk = this.getChunk(cx, cz);
        return chunk.blocks[this.getBlockIndex(lx, wy, lz)] || 0;
    }

    setBlock(wx, wy, wz, blockType) {
        if (wy < 0 || wy >= this.chunkHeight) return;

        const cx = Math.floor(wx / this.chunkSize);
        const cz = Math.floor(wz / this.chunkSize);
        const lx = ((wx % this.chunkSize) + this.chunkSize) % this.chunkSize;
        const lz = ((wz % this.chunkSize) + this.chunkSize) % this.chunkSize;

        const chunk = this.getChunk(cx, cz);
        const idx = this.getBlockIndex(lx, wy, lz);
        const prevBlock = chunk.blocks[idx];
        chunk.blocks[idx] = blockType;
        chunk.modified = true;
        chunk.playerModified = true; // Mark this chunk as modified by player action

        // Recompute skylight for this and neighbors
        this.recomputeLightingAround(cx, cz);

        // If a torch/magic candle was added or removed, only recompute lighting around it (not globally)
        const isEmissive = (b) => b === 25 || b === 29;
        if (isEmissive(prevBlock) || isEmissive(blockType)) {
            // Only recompute block lights in nearby chunks to avoid global recalc lag
            this.propagateBlockLightLocalAround(wx, wy, wz);
        }
    }

    propagateBlockLightLocalAround(wx, wy, wz) {
        // Recompute block lights only in a 3x3 area of chunks around the light source
        const cx = Math.floor(wx / this.chunkSize);
        const cz = Math.floor(wz / this.chunkSize);
        
        for (let ocx = cx - 1; ocx <= cx + 1; ocx++) {
            for (let ocz = cz - 1; ocz <= cz + 1; ocz++) {
                const chunk = this.getChunk(ocx, ocz);
                if (chunk && chunk.blockLight) {
                    // Clear blockLight in this chunk
                    chunk.blockLight.fill(0);
                }
            }
        }
        
        // Propagate from sources in nearby chunks only
        for (let ocx = cx - 1; ocx <= cx + 1; ocx++) {
            for (let ocz = cz - 1; ocz <= cz + 1; ocz++) {
                const chunk = this.getChunk(ocx, ocz);
                if (chunk) {
                    try {
                        this.propagateBlockLightFromSources(chunk, ocx, ocz);
                    } catch (e) {
                        console.error(`Error propagating block light at chunk (${ocx}, ${ocz}):`, e);
                    }
                }
            }
        }
    }

    isTransparentForLight(blockType) {
        // Non-solid and light-permeable blocks allow light through
        return !this.isBlockSolid(blockType);
    }

    getChunkAndLocal(wx, wy, wz) {
        const cx = Math.floor(wx / this.chunkSize);
        const cz = Math.floor(wz / this.chunkSize);
        const lx = ((wx % this.chunkSize) + this.chunkSize) % this.chunkSize;
        const lz = ((wz % this.chunkSize) + this.chunkSize) % this.chunkSize;
        const chunk = this.chunks.get(this.getChunkKey(cx, cz));
        if (!chunk) return null;
        return { chunk, cx, cz, lx, ly: wy, lz };
    }

    getSkyLight(wx, wy, wz) {
        if (wy < 0 || wy >= this.chunkHeight) return 0;
        const data = this.getChunkAndLocal(wx, wy, wz);
        if (!data) return 0;
        return data.chunk.skyLight[this.getLightIndex(data.lx, wy, data.lz)] || 0;
    }

    getBlockLight(wx, wy, wz) {
        if (wy < 0 || wy >= this.chunkHeight) return 0;
        const data = this.getChunkAndLocal(wx, wy, wz);
        if (!data) return 0;
        return data.chunk.blockLight[this.getLightIndex(data.lx, wy, data.lz)] || 0;
    }

    getCombinedLight(wx, wy, wz) {
        const skyRaw = this.getSkyLight(wx, wy, wz) / this.maxLightLevel;
        const sky = skyRaw * (this.sunlightFactor || 1.0);
        const blockRaw = this.getBlockLight(wx, wy, wz) / this.maxLightLevel;
        // Brighter block lights in Astral; allow higher-than-normal brightness
        const blockBoost = (this.worldType === 'astral') ? 1.5 : 1.35;
        const block = blockRaw * blockBoost;
        // Let block light dominate, skylight provides base
        let combined = Math.max(block, sky);
        // Permit up to 1.50 brightness in Astral
        const maxCombined = (this.worldType === 'astral') ? 1.5 : 1.0;
        combined = Math.min(maxCombined, combined);
        // Always ensure at least ambient floor
        const ambient = this.ambientMinimum || 0.15;
        return Math.max(combined, ambient);
    }

    computeSkylightForChunk(chunk, cx, cz) {
        const cs = this.chunkSize;
        const ch = this.chunkHeight;
        chunk.skyLight.fill(0);

        // Simple vertical skylight: open sky columns get max light that decays downward until blocked
        for (let x = 0; x < cs; x++) {
            for (let z = 0; z < cs; z++) {
                let light = this.maxLightLevel;
                for (let y = ch - 1; y >= 0; y--) {
                    const idx = this.getLightIndex(x, y, z);
                    const blockType = chunk.blocks[idx];
                    if (this.isTransparentForLight(blockType)) {
                        chunk.skyLight[idx] = light;
                        // Decay per block; astral stays brighter/deeper
                        const decay = (this.worldType === 'astral') ? 0.995 : 0.98;
                        if (light > 0) light *= decay;
                    } else {
                        // Opaque blocks block skylight; reset below
                        light = 0;
                        chunk.skyLight[idx] = 0;
                    }
                }
            }
        }

        // Horizontal/vertical skylight flood-fill so side-exposed blocks receive sky light
        const queue = [];
        for (let x = 0; x < cs; x++) {
            for (let z = 0; z < cs; z++) {
                for (let y = 0; y < ch; y++) {
                    const level = chunk.skyLight[this.getLightIndex(x, y, z)];
                    if (level > 1) {
                        queue.push({ wx: cx * cs + x, wy: y, wz: cz * cs + z, level });
                    }
                }
            }
        }

        const dirs = [
            [1, 0, 0], [-1, 0, 0],
            [0, 1, 0], [0, -1, 0],
            [0, 0, 1], [0, 0, -1]
        ];

        while (queue.length > 0) {
            const { wx, wy, wz, level } = queue.shift();
            const nextLevel = level - 1;
            if (nextLevel <= 0) continue;

            for (const [dx, dy, dz] of dirs) {
                const nx = wx + dx;
                const ny = wy + dy;
                const nz = wz + dz;
                if (ny < 0 || ny >= this.chunkHeight) continue;
                const target = this.getChunkAndLocal(nx, ny, nz);
                if (!target) continue;
                const tidx = this.getLightIndex(target.lx, ny, target.lz);
                const blockType = target.chunk.blocks[tidx];
                if (!this.isTransparentForLight(blockType)) continue;
                if ((target.chunk.skyLight[tidx] || 0) >= nextLevel) continue;
                target.chunk.skyLight[tidx] = nextLevel;
                queue.push({ wx: nx, wy: ny, wz: nz, level: nextLevel });
            }
        }
    }

    propagateBlockLightFromSources(chunk, cx, cz) {
        const cs = this.chunkSize;
        const ch = this.chunkHeight;
        chunk.blockLight.fill(0);

        const queue = [];
        const pushLight = (wx, wy, wz, level) => {
            if (wy < 0 || wy >= ch || level <= 0) return;
            const target = this.getChunkAndLocal(wx, wy, wz);
            if (!target) return;
            const idx = this.getLightIndex(target.lx, wy, target.lz);
            if (target.chunk.blockLight[idx] >= level) return;
            target.chunk.blockLight[idx] = level;
            queue.push({ wx, wy, wz, level });
        };

        // Seed with torches and emissive blocks (torch=25, magic candle=29)
        for (let x = 0; x < cs; x++) {
            for (let z = 0; z < cs; z++) {
                for (let y = 0; y < ch; y++) {
                    const idx = this.getLightIndex(x, y, z);
                    const blockType = chunk.blocks[idx];
                    if (blockType === 25 || blockType === 29) {
                        const wx = cx * cs + x;
                        const wz = cz * cs + z;
                        const wy = y;
                        pushLight(wx, wy, wz, this.maxLightLevel);
                    }
                }
            }
        }

        // 6-direction flood fill with decay
        const dirs = [
            [1, 0, 0], [-1, 0, 0],
            [0, 1, 0], [0, -1, 0],
            [0, 0, 1], [0, 0, -1]
        ];

        while (queue.length > 0) {
            const { wx, wy, wz, level } = queue.shift();
            const nextLevel = level - 1;
            if (nextLevel <= 0) continue;

            for (const [dx, dy, dz] of dirs) {
                const nx = wx + dx;
                const ny = wy + dy;
                const nz = wz + dz;
                const neighbor = this.getChunkAndLocal(nx, ny, nz);
                if (!neighbor) continue;
                const nIdx = this.getLightIndex(neighbor.lx, ny, neighbor.lz);
                const blockType = neighbor.chunk.blocks[nIdx];
                if (!this.isTransparentForLight(blockType)) continue;
                if (neighbor.chunk.blockLight[nIdx] >= nextLevel) continue;
                neighbor.chunk.blockLight[nIdx] = nextLevel;
                queue.push({ wx: nx, wy: ny, wz: nz, level: nextLevel });
            }
        }
    }

    computeLightingForChunk(cx, cz) {
        const key = this.getChunkKey(cx, cz);
        const chunk = this.chunks.get(key);
        if (!chunk) return;
        this.computeSkylightForChunk(chunk, cx, cz);
        this.propagateBlockLightFromSources(chunk, cx, cz);
    }

    recomputeLightingAround(cx, cz) {
        // Recompute this chunk and its immediate neighbors for light continuity
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                const k = this.getChunkKey(cx + dx, cz + dz);
                if (this.chunks.has(k)) {
                    this.computeLightingForChunk(cx + dx, cz + dz);
                }
            }
        }
    }

    // Recompute block lights across all loaded chunks.
    // Clears existing blockLight and re-propagates from all emissive sources (torch=25, candle=29).
    recomputeAllBlockLights() {
        // Clear blockLight in all chunks first to avoid stale values
        for (const chunk of this.chunks.values()) {
            if (chunk && chunk.blockLight) {
                chunk.blockLight.fill(0);
            }
        }
        // Propagate from sources in every chunk; propagation crosses chunk boundaries
        for (const chunk of this.chunks.values()) {
            if (!chunk) continue;
            const { cx, cz } = chunk;
            this.propagateBlockLightFromSources(chunk, cx, cz);
        }
    }

    isBlockSolid(blockType) {
        // Treat water (5), lava (34), leafs (11), torch (25), magic candle (29) as non-solid for face culling/collision
        return blockType > 0 && blockType !== 5 && blockType !== 34 && blockType !== 11 && blockType !== 25 && blockType !== 29;
    }

    getVisibleBlocksInChunk(cx, cz) {
        const chunk = this.getChunk(cx, cz);
        const visibleBlocks = [];

        for (let x = 0; x < this.chunkSize; x++) {
            for (let y = 0; y < this.chunkHeight; y++) {
                for (let z = 0; z < this.chunkSize; z++) {
                    const blockType = chunk.blocks[this.getBlockIndex(x, y, z)];
                    if (blockType === 0) continue; // Skip air

                    // Check if any face is exposed
                    const wx = cx * this.chunkSize + x;
                    const wy = y;
                    const wz = cz * this.chunkSize + z;

                    let hasVisibleFace = false;
                    // Check 6 neighbors
                    if (this.getBlock(wx + 1, wy, wz) === 0) hasVisibleFace = true;
                    if (this.getBlock(wx - 1, wy, wz) === 0) hasVisibleFace = true;
                    if (this.getBlock(wx, wy + 1, wz) === 0) hasVisibleFace = true;
                    if (this.getBlock(wx, wy - 1, wz) === 0) hasVisibleFace = true;
                    if (this.getBlock(wx, wy, wz + 1) === 0) hasVisibleFace = true;
                    if (this.getBlock(wx, wy, wz - 1) === 0) hasVisibleFace = true;

                    if (hasVisibleFace) {
                        visibleBlocks.push({ x: wx, y: wy, z: wz, blockType });
                    }
                }
            }
        }

        return visibleBlocks;
    }
}

class BlockMesher {
    constructor(world, textureAtlas) {
        this.world = world;
        this.textureAtlas = textureAtlas;
        
        // Define texture UVs for each block type
        // Each block type gets a 64x64 region in a 256x256 atlas (4x4 grid)
        this.blockTextureUVs = {
            1: { x: 0, y: 0 },      // Dirt
            2: { x: 1, y: 0 },      // Grass
            3: { x: 2, y: 0 },      // Stone
            4: { x: 3, y: 0 },      // Sand
            5: { x: 0, y: 1 },      // Water
            6: { x: 1, y: 1 },      // Wood
            7: { x: 2, y: 1 },      // Bricks
            8: { x: 3, y: 1 },      // Ruby
            9: { x: 0, y: 2 },      // Clay
            10: { x: 1, y: 2 },     // Snow
            11: { x: 2, y: 2 },     // Leafs
            12: { x: 3, y: 2 },     // Sapphire
            24: { x: 2, y: 0 },     // Coal (use stone texture as placeholder)
            25: { x: 1, y: 3 },     // Torch
            29: { x: 1, y: 3 },     // Magic candle (reuse torch tile)
            30: { x: 2, y: 0 },     // Chisel uses stone tile
            31: { x: 1, y: 2 },     // Cloud Pillow uses snow tile
            33: { x: 2, y: 0 },     // Grim Stone (use stone texture)
            34: { x: 0, y: 1 }      // Lava (use water texture as placeholder)
        };
        
        this.textureGridSize = 4; // 4x4 grid in atlas
    }

    getBlockUVs(blockType) {
        const uv = this.blockTextureUVs[blockType] || { x: 0, y: 0 };
        const tileSize = 1 / this.textureGridSize;
        
        return {
            minU: uv.x * tileSize,
            maxU: (uv.x + 1) * tileSize,
            minV: 1 - (uv.y + 1) * tileSize,
            maxV: 1 - uv.y * tileSize
        };
    }
    
    getDefaultUVs() {
        // Standard full texture UVs (for backwards compatibility)
        return {
            minU: 0,
            maxU: 1,
            minV: 0,
            maxV: 1
        };
    }

    createChunkMesh(cx, cz) {
        console.log(`Creating mesh for chunk ${cx},${cz}`);
        const geometry = new THREE.BufferGeometry();
        const positions = [];
        const uvs = [];
        const colors = [];
        const indices = [];
        const waterPositions = [];
        const waterUvs = [];
        const waterColors = [];
        const waterIndices = [];
        const leafPositions = [];
        const leafUvs = [];
        const leafColors = [];
        const leafIndices = [];
        const torchPositions = [];
        const torchUvs = [];
        const torchColors = [];
        const torchIndices = [];
        const magicTorchPositions = [];
        const magicTorchUvs = [];
        const magicTorchColors = [];
        const magicTorchIndices = [];
        const lavaPositions = [];
        const lavaUvs = [];
        const lavaColors = [];
        const lavaIndices = [];
        const linePositions = [];
        const waterLinePositions = [];
        const lavaLinePositions = [];
        const leafLinePositions = [];
        const torchLinePositions = [];
        const magicTorchLinePositions = [];

        const visibleBlocks = this.world.getVisibleBlocksInChunk(cx, cz);
        console.log(`Found ${visibleBlocks.length} visible blocks`);
        // Debug: remember first visible block for inspection
        const debugFirstBlock = visibleBlocks.length ? visibleBlocks[0] : null;
        let vertexCount = 0;

        const scale = this.world.tileSize;
        const chunkOriginX = cx * this.world.chunkSize;
        const chunkOriginZ = cz * this.world.chunkSize;

        for (const block of visibleBlocks) {
            const { x, y, z, blockType } = block; // x,z are world coords

            // Separate water, lava, and leafs from other blocks
            if (blockType === 5) {
                this.addBlockFaces(x, y, z, blockType, scale, waterPositions, waterUvs, waterColors, waterIndices, waterLinePositions);
            } else if (blockType === 34) {
                this.addBlockFaces(x, y, z, blockType, scale, lavaPositions, lavaUvs, lavaColors, lavaIndices, lavaLinePositions);
            } else if (blockType === 11) {
                this.addBlockFaces(x, y, z, blockType, scale, leafPositions, leafUvs, leafColors, leafIndices, leafLinePositions);
            } else if (blockType === 25) {
                // Torch special rendering as 3 small cubes into separate emissive torch mesh
                this.addTorchGeometry(x, y, z, scale, torchPositions, torchUvs, torchColors, torchIndices, torchLinePositions);
            } else if (blockType === 29) {
                // Magic candle uses torch mesh but blue/silver material
                this.addTorchGeometry(x, y, z, scale, magicTorchPositions, magicTorchUvs, magicTorchColors, magicTorchIndices, magicTorchLinePositions);
            } else {
                // For each visible block, emit quads for exposed faces
                this.addBlockFaces(x, y, z, blockType, scale, positions, uvs, colors, indices, linePositions);
            }
        }

        console.log(`Mesh has ${positions.length / 3} vertices, ${indices.length} indices`);
        
        if (positions.length === 0 && waterPositions.length === 0 && lavaPositions.length === 0) {
            console.log('No positions, returning null mesh');
            return null;
        }

        // Create main mesh (non-water blocks)
        let mesh = null;
        if (positions.length > 0) {
            geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
            geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
            geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
            
            let indexArray;
            if (indices.length < 65535) {
                indexArray = new Uint16Array(indices);
            } else {
                indexArray = new Uint32Array(indices);
            }
            geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
            geometry.computeVertexNormals();

            const material = new THREE.MeshLambertMaterial({
                map: this.textureAtlas,
                side: THREE.DoubleSide,
                vertexColors: true
            });

            mesh = new THREE.Mesh(geometry, material);
            
            // Add explicit wireframe edges for all block edges
            if (linePositions.length > 0) {
                const lineGeometry = new THREE.BufferGeometry();
                lineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(linePositions), 3));
                const lineMaterial = new THREE.LineBasicMaterial({ color: 0x000000 });
                const wireframe = new THREE.LineSegments(lineGeometry, lineMaterial);
                mesh.add(wireframe);
            }
        }

        // Create water mesh (transparent)
        if (waterPositions.length > 0) {
            const waterGeometry = new THREE.BufferGeometry();
            waterGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(waterPositions), 3));
            waterGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(waterUvs), 2));
            waterGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(waterColors), 3));
            
            let waterIndexArray;
            if (waterIndices.length < 65535) {
                waterIndexArray = new Uint16Array(waterIndices);
            } else {
                waterIndexArray = new Uint32Array(waterIndices);
            }
            waterGeometry.setIndex(new THREE.BufferAttribute(waterIndexArray, 1));
            waterGeometry.computeVertexNormals();

            const waterMaterial = new THREE.MeshLambertMaterial({
                map: this.textureAtlas,
                color: 0x0099FF,
                transparent: true,
                opacity: 0.6,
                side: THREE.DoubleSide,
                vertexColors: true
            });

            const waterMesh = new THREE.Mesh(waterGeometry, waterMaterial);
            // Add wireframe to water
            if (waterLinePositions.length > 0) {
                const waterLineGeometry = new THREE.BufferGeometry();
                waterLineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(waterLinePositions), 3));
                const waterLineMaterial = new THREE.LineBasicMaterial({ color: 0x000000 });
                const waterWireframe = new THREE.LineSegments(waterLineGeometry, waterLineMaterial);
                waterMesh.add(waterWireframe);
            }
            
            // If we have a main mesh, add water as a child; otherwise water is the main mesh
            if (mesh) {
                mesh.add(waterMesh);
            } else {
                mesh = waterMesh;
            }
        }

        // Create lava mesh (glowing orange-red fluid)
        if (lavaPositions.length > 0) {
            const lavaGeometry = new THREE.BufferGeometry();
            lavaGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lavaPositions), 3));
            lavaGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(lavaUvs), 2));
            lavaGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(lavaColors), 3));
            
            let lavaIndexArray;
            if (lavaIndices.length < 65535) {
                lavaIndexArray = new Uint16Array(lavaIndices);
            } else {
                lavaIndexArray = new Uint32Array(lavaIndices);
            }
            lavaGeometry.setIndex(new THREE.BufferAttribute(lavaIndexArray, 1));
            lavaGeometry.computeVertexNormals();

            const lavaMaterial = new THREE.MeshLambertMaterial({
                map: this.textureAtlas,
                color: 0xFF6600,
                transparent: true,
                opacity: 0.75,
                emissive: 0xFF4500,
                emissiveIntensity: 0.8,
                side: THREE.DoubleSide,
                vertexColors: true
            });

            const lavaMesh = new THREE.Mesh(lavaGeometry, lavaMaterial);
            // Add wireframe to lava
            if (lavaLinePositions.length > 0) {
                const lavaLineGeometry = new THREE.BufferGeometry();
                lavaLineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lavaLinePositions), 3));
                const lavaLineMaterial = new THREE.LineBasicMaterial({ color: 0x000000 });
                const lavaWireframe = new THREE.LineSegments(lavaLineGeometry, lavaLineMaterial);
                lavaMesh.add(lavaWireframe);
            }
            
            // If we have a main mesh, add lava as a child; otherwise lava is the main mesh
            if (mesh) {
                mesh.add(lavaMesh);
            } else {
                mesh = lavaMesh;
            }
        }

        // Create leafs mesh (semi-transparent green)
        if (leafPositions.length > 0) {
            const leafGeometry = new THREE.BufferGeometry();
            leafGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(leafPositions), 3));
            leafGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(leafUvs), 2));
            
            let leafIndexArray;
            if (leafIndices.length < 65535) {
                leafIndexArray = new Uint16Array(leafIndices);
            } else {
                leafIndexArray = new Uint32Array(leafIndices);
            }
            leafGeometry.setIndex(new THREE.BufferAttribute(leafIndexArray, 1));
            leafGeometry.computeVertexNormals();

            const leafMaterial = new THREE.MeshLambertMaterial({
                map: this.textureAtlas,
                color: 0x22AA22, // Green
                transparent: true,
                opacity: 0.75,
                alphaTest: 0.5,
                side: THREE.DoubleSide
            });

            const leafMesh = new THREE.Mesh(leafGeometry, leafMaterial);
            // Add wireframe to leafs
            if (leafLinePositions.length > 0) {
                const leafLineGeometry = new THREE.BufferGeometry();
                leafLineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(leafLinePositions), 3));
                const leafLineMaterial = new THREE.LineBasicMaterial({ color: 0x000000 });
                const leafWireframe = new THREE.LineSegments(leafLineGeometry, leafLineMaterial);
                leafMesh.add(leafWireframe);
            }
            
            // Add leafs to scene hierarchy
            if (mesh) {
                mesh.add(leafMesh);
            } else {
                mesh = leafMesh;
            }
        }

        // Create torch mesh with emissive material so torches look bright
        if (torchPositions.length > 0) {
            const torchGeometry = new THREE.BufferGeometry();
            torchGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(torchPositions), 3));
            torchGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(torchUvs), 2));
            let torchIndexArray;
            if (torchIndices.length < 65535) {
                torchIndexArray = new Uint16Array(torchIndices);
            } else {
                torchIndexArray = new Uint32Array(torchIndices);
            }
            torchGeometry.setIndex(new THREE.BufferAttribute(torchIndexArray, 1));
            torchGeometry.computeVertexNormals();

            const torchMaterial = new THREE.MeshLambertMaterial({
                map: this.textureAtlas,
                color: 0xFFD36B, // warm gold tone
                emissive: new THREE.Color(0xFFAA33),
                emissiveIntensity: 2.0,
                side: THREE.DoubleSide
            });

            const torchMesh = new THREE.Mesh(torchGeometry, torchMaterial);
            // Add wireframe to torches
            if (torchLinePositions.length > 0) {
                const torchLineGeometry = new THREE.BufferGeometry();
                torchLineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(torchLinePositions), 3));
                const torchLineMaterial = new THREE.LineBasicMaterial({ color: 0x000000 });
                const torchWireframe = new THREE.LineSegments(torchLineGeometry, torchLineMaterial);
                torchMesh.add(torchWireframe);
            }
            if (mesh) {
                mesh.add(torchMesh);
            } else {
                mesh = torchMesh;
            }
        }

        // Create magic candle mesh (blue/silver emissive)
        if (magicTorchPositions.length > 0) {
            const magicGeometry = new THREE.BufferGeometry();
            magicGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(magicTorchPositions), 3));
            magicGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(magicTorchUvs), 2));
            let magicIndexArray;
            if (magicTorchIndices.length < 65535) {
                magicIndexArray = new Uint16Array(magicTorchIndices);
            } else {
                magicIndexArray = new Uint32Array(magicTorchIndices);
            }
            magicGeometry.setIndex(new THREE.BufferAttribute(magicIndexArray, 1));
            magicGeometry.computeVertexNormals();

            const magicMaterial = new THREE.MeshLambertMaterial({
                map: this.textureAtlas,
                color: 0x7fb7ff, // blue tint
                emissive: new THREE.Color(0xa6d3ff),
                emissiveIntensity: 2.0,
                side: THREE.DoubleSide
            });

            const magicMesh = new THREE.Mesh(magicGeometry, magicMaterial);
            if (magicTorchLinePositions.length > 0) {
                const magicLineGeometry = new THREE.BufferGeometry();
                magicLineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(magicTorchLinePositions), 3));
                const magicLineMaterial = new THREE.LineBasicMaterial({ color: 0xC0C0C0 });
                const magicWireframe = new THREE.LineSegments(magicLineGeometry, magicLineMaterial);
                magicMesh.add(magicWireframe);
            }
            if (mesh) {
                mesh.add(magicMesh);
            } else {
                mesh = magicMesh;
            }
        }

        console.log('Mesh created successfully');

        return mesh;
    }

    // Torch as 3 smaller cubes stacked vertically within the voxel
    addTorchGeometry(wx, y, wz, scale, positions, uvs, colors, indices, linePositions) {
        const s = scale;
        const baseX = wx * s;
        const baseY = y * s;
        const baseZ = wz * s;

        // Helper to add a small cube centered at offsets with given size and uv from a block type
        const addSmallCube = (cx, cy, cz, size, uvBlockType) => {
            const uv = this.getBlockUVs(uvBlockType);
            const half = size / 2;
            const px = baseX + cx;
            const py = baseY + cy;
            const pz = baseZ + cz;

            const corners = {
                '000': [px - half, py - half, pz - half],
                '100': [px + half, py - half, pz - half],
                '110': [px + half, py + half, pz - half],
                '010': [px - half, py + half, pz - half],
                '001': [px - half, py - half, pz + half],
                '101': [px + half, py - half, pz + half],
                '111': [px + half, py + half, pz + half],
                '011': [px - half, py + half, pz + half]
            };

            const addQuad = (v0, v1, v2, v3) => {
                const idx = positions.length / 3;
                positions.push(...v0, ...v1, ...v2, ...v3);
                uvs.push(
                    uv.minU, uv.maxV,
                    uv.minU, uv.minV,
                    uv.maxU, uv.minV,
                    uv.maxU, uv.maxV
                );
                // Colors per vertex: flame bright, stick follows local light
                let rf, gf, bf;
                if (uvBlockType === 25) {
                    rf = 1.0; gf = 0.95; bf = 0.85;
                } else {
                    const lf = this.world.getCombinedLight(wx, y, wz);
                    rf = lf; gf = lf; bf = lf;
                }
                colors.push(rf, gf, bf, rf, gf, bf, rf, gf, bf, rf, gf, bf);
                indices.push(idx, idx + 1, idx + 2, idx, idx + 2, idx + 3);
            };

            // Always render all faces (tiny cube inside voxel)
            addQuad(corners['000'], corners['010'], corners['110'], corners['100']); // -Z
            addQuad(corners['001'], corners['101'], corners['111'], corners['011']); // +Z
            addQuad(corners['000'], corners['001'], corners['011'], corners['010']); // -X
            addQuad(corners['100'], corners['110'], corners['111'], corners['101']); // +X
            addQuad(corners['000'], corners['100'], corners['101'], corners['001']); // -Y
            addQuad(corners['010'], corners['011'], corners['111'], corners['110']); // +Y

            // Add wireframe edges for this small cube
            if (linePositions) {
                // Bottom square
                linePositions.push(...corners['000'], ...corners['100']);
                linePositions.push(...corners['100'], ...corners['101']);
                linePositions.push(...corners['101'], ...corners['001']);
                linePositions.push(...corners['001'], ...corners['000']);
                // Top square
                linePositions.push(...corners['010'], ...corners['110']);
                linePositions.push(...corners['110'], ...corners['111']);
                linePositions.push(...corners['111'], ...corners['011']);
                linePositions.push(...corners['011'], ...corners['010']);
                // Vertical edges
                linePositions.push(...corners['000'], ...corners['010']);
                linePositions.push(...corners['100'], ...corners['110']);
                linePositions.push(...corners['101'], ...corners['111']);
                linePositions.push(...corners['001'], ...corners['011']);
            }
        };

        // Sizes and positions: make a thin stick and small flame
        const stickSize = s * 0.18; // thin rod width
        const segmentHeight = s * 0.28;
        const centerX = s * 0.5;
        const centerZ = s * 0.5;

        // Two brown segments (use wood block UV 6)
        addSmallCube(centerX, segmentHeight * 0.5, centerZ, stickSize, 6);
        addSmallCube(centerX, segmentHeight * 1.2, centerZ, stickSize, 6);

        // Top gold flame (use torch block UV 25)
        const flameSize = s * 0.22;
        addSmallCube(centerX, segmentHeight * 2.0, centerZ, flameSize, 25);
    }

    addBlockFaces(wx, y, wz, blockType, scale, positions, uvs, colors, indices, linePositions) {
        const uv = this.getBlockUVs(blockType);

        const s = scale;
        // Use world coordinates directly for vertex positions
        const px = wx * s;
        const py = y * s;
        const pz = wz * s;

        // Helper to add a quad (2 triangles) with a provided light factor
        const addQuad = (v0, v1, v2, v3, lf) => {
            const idx = positions.length / 3;
            positions.push(...v0, ...v1, ...v2, ...v3);
            // Add UV coordinates for the quad
            uvs.push(
                uv.minU, uv.maxV,  // v0 - bottom-left
                uv.minU, uv.minV,  // v1 - top-left
                uv.maxU, uv.minV,  // v2 - top-right
                uv.maxU, uv.maxV   // v3 - bottom-right
            );
            const r = lf, g = lf, b = lf;
            colors.push(r, g, b, r, g, b, r, g, b, r, g, b);
            indices.push(idx, idx + 1, idx + 2, idx, idx + 2, idx + 3);
        };

        // Define 8 corners of the cube in world space
        const corners = {
            '000': [px, py, pz],
            '100': [px + s, py, pz],
            '110': [px + s, py + s, pz],
            '010': [px, py + s, pz],
            '001': [px, py, pz + s],
            '101': [px + s, py, pz + s],
            '111': [px + s, py + s, pz + s],
            '011': [px, py + s, pz + s]
        };

        // Use world coordinates for neighbor checks and sample neighbor light per face
        // Front face (-Z)
        if (!this.world.isBlockSolid(this.world.getBlock(wx, y, wz - 1))) {
            const lfFront = this.world.getCombinedLight(wx, y, wz - 1);
            addQuad(corners['000'], corners['010'], corners['110'], corners['100'], lfFront);
        }
        // Back face (+Z)
        if (!this.world.isBlockSolid(this.world.getBlock(wx, y, wz + 1))) {
            const lfBack = this.world.getCombinedLight(wx, y, wz + 1);
            addQuad(corners['001'], corners['101'], corners['111'], corners['011'], lfBack);
        }
        // Left face (-X)
        if (!this.world.isBlockSolid(this.world.getBlock(wx - 1, y, wz))) {
            const lfLeft = this.world.getCombinedLight(wx - 1, y, wz);
            addQuad(corners['000'], corners['001'], corners['011'], corners['010'], lfLeft);
        }
        // Right face (+X)
        if (!this.world.isBlockSolid(this.world.getBlock(wx + 1, y, wz))) {
            const lfRight = this.world.getCombinedLight(wx + 1, y, wz);
            addQuad(corners['100'], corners['110'], corners['111'], corners['101'], lfRight);
        }
        // Bottom face (-Y)
        if (!this.world.isBlockSolid(this.world.getBlock(wx, y - 1, wz))) {
            const lfBottom = this.world.getCombinedLight(wx, y - 1, wz);
            addQuad(corners['000'], corners['100'], corners['101'], corners['001'], lfBottom);
        }
        // Top face (+Y)
        if (!this.world.isBlockSolid(this.world.getBlock(wx, y + 1, wz))) {
            const lfTop = this.world.getCombinedLight(wx, y + 1, wz);
            addQuad(corners['010'], corners['011'], corners['111'], corners['110'], lfTop);
        }

        // Add wireframe edges for this block (12 edges of the cube)
        if (linePositions) {
            // Bottom square
            linePositions.push(...corners['000'], ...corners['100']);
            linePositions.push(...corners['100'], ...corners['101']);
            linePositions.push(...corners['101'], ...corners['001']);
            linePositions.push(...corners['001'], ...corners['000']);
            // Top square
            linePositions.push(...corners['010'], ...corners['110']);
            linePositions.push(...corners['110'], ...corners['111']);
            linePositions.push(...corners['111'], ...corners['011']);
            linePositions.push(...corners['011'], ...corners['010']);
            // Vertical edges
            linePositions.push(...corners['000'], ...corners['010']);
            linePositions.push(...corners['100'], ...corners['110']);
            linePositions.push(...corners['101'], ...corners['111']);
            linePositions.push(...corners['001'], ...corners['011']);
        }
    }
}

class Player {
    constructor(survivalMode = false) {
        this.position = new THREE.Vector3(0, 70, 0);
        this.velocity = new THREE.Vector3(0, 0, 0);
        this.yaw = 0;
        this.pitch = 0;
        this.speed = 0.15;
            this.sprintSpeed = 0.25; // Speed when sprinting
        this.jumpPower = 0.3;
        this.gravity = 0.015;
        this.onGround = false;
        this.flyMode = false; // Toggle with F6
            // Sprint tracking for double-tap W
            this.lastWPressTime = 0;
            this.wDoubleTapWindow = 300; // ms to detect double-tap
            this.isSprinting = false;
            this.sprintEndTime = 0; // When sprint expires
            this.sprintDuration = 1500; // Sprint lasts 1.5 seconds
        // Collider dimensions (width, height, depth)
            this.size = new THREE.Vector3(0.5, 2.0, 0.5); // 2-block tall player
        this.selectedBlock = 1; // Dirt
        this.wDisabledUntil = 0; // timestamp to ignore forward input when hugging wall

        // Survival mode
        this.survivalMode = survivalMode;
        this.maxHealth = 20;
        this.health = 20;
        this.isDead = false;
        this.invulnerableUntil = 0; // Damage cooldown

        // Input state
        this.keys = {};
        // Inventory: 30 slots, 0 = empty
        this.inventory = new Array(30).fill(0);
        
        // Equipment slots
        this.equipment = {
            head: 0,
            body: 0,
            legs: 0,
            boots: 0,
            mainHand: 0,
            offHand: 0,
            tool: 0
        };
        
        // In survival mode, start with empty inventory - must break blocks to collect them
        if (!survivalMode) {
            this.inventory[0] = 1;   // Dirt
            this.inventory[1] = 2;   // Grass
            this.inventory[2] = 3;   // Stone
            this.inventory[3] = 4;   // Sand
            this.inventory[4] = 5;   // Water
            this.inventory[5] = 6;   // Wood
            this.inventory[6] = 7;   // Bricks
            this.inventory[7] = 8;   // Ruby
            this.inventory[8] = 9;   // Clay
            this.inventory[9] = 10;  // Snow
            this.inventory[10] = 11; // Leafs
            this.inventory[11] = 12; // Sapphire
            this.inventory[12] = 29; // Magic candle
        }
    }

    update(world, deltaTime) {
                // Check if sprint should expire
                const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
                    if (this.isSprinting && now >= this.sprintEndTime) {
                    this.isSprinting = false;
                    console.log('Sprint ended');
                }

        // Detect if player is inside water (block id 5) at feet or head level
        const halfHeight = this.size.y / 2;
        const blockAtFeet = world.getBlock(Math.floor(this.position.x), Math.floor(this.position.y - halfHeight), Math.floor(this.position.z));
        const blockAtHead = world.getBlock(Math.floor(this.position.x), Math.floor(this.position.y + halfHeight - 0.1), Math.floor(this.position.z));
        const inWater = blockAtFeet === 5 || blockAtHead === 5;
        this.inWater = inWater;

        // Apply gravity (disabled in fly mode)
        if (!this.flyMode && !this.onGround) {
            const gravityForce = inWater ? this.gravity * 0.35 : this.gravity; // Lighter gravity in water
            this.velocity.y -= gravityForce;
        }

        // Swimming upward: hold space to rise while in water
        if (inWater && this.keys[' ']) {
            const swimAccel = 0.06;
            const maxSwimUp = 0.18;
            this.velocity.y = Math.min(this.velocity.y + swimAccel, maxSwimUp);
        }

        // Limit fall speed while submerged
        if (inWater) {
            this.velocity.y = Math.max(this.velocity.y, -0.12);
        }

        // Movement - use yaw/pitch to determine direction
        const moveDir = new THREE.Vector3();

        const wAllowed = now >= (this.wDisabledUntil || 0);
        const arrowUp = this.keys['arrowup'];
        const arrowDown = this.keys['arrowdown'];
        const wPressed = (this.keys['w'] || (arrowUp && !this.flyMode)) && wAllowed;
        if (wPressed) moveDir.z -= 1;
        if (this.keys['s'] || (arrowDown && !this.flyMode)) moveDir.z += 1;
        if (this.keys['a'] || this.keys['arrowleft']) moveDir.x -= 1;
        if (this.keys['d'] || this.keys['arrowright']) moveDir.x += 1;
        
        // Vertical movement in fly mode (use arrow up/down plus space/shift)
        if (this.flyMode) {
            if (arrowUp || this.keys[' ']) moveDir.y += 1;
            if (arrowDown || this.keys['shift']) moveDir.y -= 1;
        }

        const currentSpeed = this.isSprinting ? this.sprintSpeed : this.speed;

        if (moveDir.length() > 0) {
            moveDir.normalize();
            
            // Get forward direction from yaw (ignore pitch for movement)
            const forward = new THREE.Vector3(
                Math.sin(this.yaw),
                0,
                Math.cos(this.yaw)
            );
            
            // Get right direction (perpendicular to forward)
            const right = new THREE.Vector3(
                Math.cos(this.yaw),
                0,
                -Math.sin(this.yaw)
            );

            // Calculate movement velocity based on forward/right vectors
            const movement = new THREE.Vector3();
            movement.addScaledVector(forward, moveDir.z);
            movement.addScaledVector(right, moveDir.x);
            movement.normalize();

            this.velocity.x = movement.x * currentSpeed;
            this.velocity.z = movement.z * currentSpeed;
            if (this.flyMode) this.velocity.y = movement.y * currentSpeed;
        } else {
            this.velocity.x *= 0.85;
            this.velocity.z *= 0.85;
            if (this.flyMode) this.velocity.y *= 0.85;
        }

        // Check collision and apply movement
        // Movement is applied inside resolveCollisions (per-axis sliding)
        // Skip collision checks in fly mode
        if (!this.flyMode) {
            this.resolveCollisions(world);
        } else {
            // In fly mode, just apply velocity directly with no collision
            this.position.add(this.velocity);
        }

        // Ground detection — ensure block top is near player's feet (disabled in fly mode)
        this.onGround = false;
        if (!this.flyMode) {
            const halfY = this.size.y / 2;
            const feetY = this.position.y - halfY; // exact feet world Y

            // Sample blocks under player in a small horizontal radius
            const sampleOffsets = [0, -0.3, 0.3];
            for (let ox of sampleOffsets) {
                for (let oz of sampleOffsets) {
                    const bx = Math.floor(this.position.x + ox);
                    const bz = Math.floor(this.position.z + oz);
                    const by = Math.floor(feetY - 0.01); // block directly under feet

                    if (!world.isBlockSolid(world.getBlock(bx, by, bz))) continue;

                    const blockTop = by + 1; // world Y of the top of that block
                    const gap = blockTop - feetY; // positive if block top is above feet

                    // Consider on ground only if feet are very close to block top
                    if (gap >= -0.02 && gap <= 0.25) {
                        this.onGround = true;
                        break;
                    }
                }
                if (this.onGround) break;
            }
        }

        // Limit fall speed (not in fly mode)
        if (!this.flyMode) {
            this.velocity.y = Math.max(this.velocity.y, -0.5);

            // Prevent moving into ground
            if (this.onGround && this.velocity.y < 0) {
                this.velocity.y = 0;
            }
        }
    }

    resolveCollisions(world) {
        // AABB collision with axis-aligned sliding
        const halfX = this.size.x / 2;
        const halfZ = this.size.z / 2;
        const halfY = this.size.y / 2;

        // Check 8 corners of bounding box
        const checkCollision = (pos) => {
            return world.isBlockSolid(world.getBlock(Math.floor(pos[0]), Math.floor(pos[1]), Math.floor(pos[2])));
        };

        const getCorners = (position) => [
            [position.x - halfX, position.y - halfY, position.z - halfZ],
            [position.x + halfX, position.y - halfY, position.z - halfZ],
            [position.x - halfX, position.y + halfY, position.z - halfZ],
            [position.x + halfX, position.y + halfY, position.z - halfZ],
            [position.x - halfX, position.y - halfY, position.z + halfZ],
            [position.x + halfX, position.y - halfY, position.z + halfZ],
            [position.x - halfX, position.y + halfY, position.z + halfZ],
            [position.x + halfX, position.y + halfY, position.z + halfZ],
        ];

        // Check if any corner is colliding
        const hasCollision = (pos) => {
            const corners = getCorners(pos);
            for (const corner of corners) {
                if (checkCollision(corner)) {
                    return true;
                }
            }
            return false;
        };

        // Try to slide along blocks by testing each axis separately
        const testPos = this.position.clone();
        
        // Try X movement
        testPos.x = this.position.x + this.velocity.x;
        if (!hasCollision(testPos)) {
            this.position.x = testPos.x;
        } else {
            // X blocked - try auto-step up if there's a one-block step
            const stepHeight = 0.6; // Max auto-step height
            let stepped = false;
            for (let stepUp = 0.1; stepUp <= stepHeight; stepUp += 0.1) {
                testPos.y = this.position.y + stepUp;
                testPos.x = this.position.x + this.velocity.x;
                if (!hasCollision(testPos)) {
                    // Can step up - check headroom
                    const headPos = testPos.clone();
                    headPos.y += halfY;
                    if (!hasCollision(headPos)) {
                        this.position.x = testPos.x;
                        this.position.y = testPos.y;
                        stepped = true;
                        break;
                    }
                }
            }
            if (!stepped) {
                this.velocity.x = 0;
            }
        }

        // Try Z movement
        testPos.z = this.position.z + this.velocity.z;
        testPos.x = this.position.x; // use updated X position
        if (!hasCollision(testPos)) {
            this.position.z = testPos.z;
        } else {
            // Z blocked - try auto-step up if there's a one-block step
            const stepHeight = 0.6;
            let stepped = false;
            for (let stepUp = 0.1; stepUp <= stepHeight; stepUp += 0.1) {
                testPos.y = this.position.y + stepUp;
                testPos.z = this.position.z + this.velocity.z;
                if (!hasCollision(testPos)) {
                    // Can step up - check headroom
                    const headPos = testPos.clone();
                    headPos.y += halfY;
                    if (!hasCollision(headPos)) {
                        this.position.z = testPos.z;
                        this.position.y = testPos.y;
                        stepped = true;
                        break;
                    }
                }
            }
            if (!stepped) {
                this.velocity.z = 0;
            }
        }

        // Try Y movement (vertical)
        testPos.y = this.position.y + this.velocity.y;
        if (!hasCollision(testPos)) {
            this.position.y = testPos.y;
        } else {
            // Y blocked, handle landing/snapping
            if (this.velocity.y < 0) {
                // falling: snap to top of the highest block under player
                const halfY = this.size.y / 2;
                const feetY = this.position.y - halfY + this.velocity.y; // candidate feet after movement

                // find the highest solid block under player's x/z near feet
                const sampleOffsets = [0, -0.3, 0.3];
                let highestTop = -Infinity;
                for (let ox of sampleOffsets) {
                    for (let oz of sampleOffsets) {
                        const bx = Math.floor(this.position.x + ox);
                        const bz = Math.floor(this.position.z + oz);
                        const by = Math.floor(feetY - 0.01);
                        if (world.isBlockSolid(world.getBlock(bx, by, bz))) {
                            const top = by + 1;
                            if (top > highestTop) highestTop = top;
                        }
                    }
                }
                if (highestTop !== -Infinity) {
                    // place player's center so feet sit slightly above block top
                    this.position.y = highestTop + halfY + 0.001;
                }
            }

            // stop vertical movement in all cases
            this.velocity.y = 0;
        }
    }

    // Simple check whether there is a solid block directly in front of the player
    isForwardBlocked(world) {
        const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        // check slightly ahead of player's center (half width + small epsilon)
        const checkDist = this.size.x / 2 + 0.15;
        const probe = this.position.clone().addScaledVector(forward, checkDist);

        // check around player's vertical center and feet
        const ys = [0, -this.size.y / 4, this.size.y / 4];
        for (const dy of ys) {
            const x = Math.floor(probe.x);
            const y = Math.floor(probe.y + dy);
            const z = Math.floor(probe.z);
            if (world.isBlockSolid(world.getBlock(x, y, z))) return true;
        }
        return false;
    }

    jump(world) {
        if (this.onGround) {
            this.velocity.y = this.jumpPower;
            this.onGround = false;
            return;
        }

        if (!world) return;

        // Allow jump when hugging a wall: if forward is blocked but there is space above and a step below
        if (this.isForwardBlocked(world)) {
            const halfY = this.size.y / 2;
            const feetY = this.position.y - halfY;
            const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
            const probe = this.position.clone().addScaledVector(forward, this.size.x / 2 + 0.15);

            const bx = Math.floor(probe.x);
            const bz = Math.floor(probe.z);
            const byFeet = Math.floor(feetY - 0.05);
            const byHead = Math.floor(this.position.y + halfY + 0.1);

            const baseBlock = world.getBlock(bx, byFeet, bz);
            const aboveBlock = world.getBlock(bx, byFeet + 1, bz);
            const headClear = !world.isBlockSolid(world.getBlock(bx, byHead, bz));

            // If there's a one-block step ahead with headroom, allow jump
            if (world.isBlockSolid(baseBlock) && !world.isBlockSolid(aboveBlock) && headClear) {
                this.velocity.y = this.jumpPower;
                this.onGround = false;
                return;
            }
        }

        // Allow jump if player is very close above a block (tolerance for hugging walls)
        const halfY = this.size.y / 2;
        const feetY = this.position.y - halfY;
        const sampleOffsets = [0, -0.3, 0.3];
        for (let ox of sampleOffsets) {
            for (let oz of sampleOffsets) {
                const bx = Math.floor(this.position.x + ox);
                const bz = Math.floor(this.position.z + oz);
                const by = Math.floor(feetY - 0.01);

                const block = world.getBlock(bx, by, bz);
                if (!block) continue;
                if (!world.isBlockSolid(block)) continue;

                const blockTop = by + 1;
                const gap = blockTop - feetY;
                // If feet are within a small tolerance above the block, snap and allow jump
                if (gap >= -0.05 && gap <= 0.35) {
                    // snap player up so feet sit just above block
                    this.position.y = blockTop + halfY + 0.001;
                    this.velocity.y = this.jumpPower;
                    this.onGround = false;
                    return;
                }
            }
        }
    }

    getAttackDamage() {
        // Calculate attack damage based on equipped weapon in mainHand
        const equipped = this.equipment.mainHand;
        let baseDamage = 1; // Default fist damage
        let damageBonus = 0;
        
        // Get base damage by sword type
        if (equipped && typeof equipped === 'object') {
            if (equipped.type === 22) {
                baseDamage = 4; // Stone Sword damage
            } else if (equipped.type === 32) {
                baseDamage = 6; // Golden Sword damage
            }
            // Apply damage bonus from scrolls
            if (equipped.damageBonus) {
                damageBonus = equipped.damageBonus;
            }
        } else if (equipped === 22) {
            // Handle legacy numeric format
            baseDamage = 4;
        } else if (equipped === 32) {
            baseDamage = 6;
        }
        
        // Apply damage bonus as percentage
        const totalDamage = baseDamage * (1 + damageBonus / 100);
        return totalDamage;
    }

    getArmorReduction() {
        // Calculate total armor damage reduction from equipped items
        // Each leather armor piece provides 5% reduction
        let armorPercent = 0;
        
        // Check each armor slot
        const armorPieces = {
            head: 18,    // Leather Helmet
            body: 19,    // Leather Chestplate
            legs: 20,    // Leather Leggings
            boots: 21    // Leather Boots
        };
        
        for (const [slot, armorType] of Object.entries(armorPieces)) {
            const equipped = this.equipment[slot];
            if (equipped && typeof equipped === 'object') {
                if (equipped.type === armorType) {
                    armorPercent += 5; // 5% per piece
                }
                if (equipped.armorBonus) {
                    armorPercent += equipped.armorBonus; // Enchantment bonus
                }
            } else if (equipped === armorType) {
                // Handle legacy numeric format
                armorPercent += 5;
            }
        }
        
        return Math.min(armorPercent, 100); // Cap at 100%
    }

    getCamera() {
        const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        camera.position.copy(this.position);
        camera.position.y += 1.3; // Eye height tuned for 1.5m tall collider
        const euler = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');
        camera.quaternion.setFromEuler(euler);
        return camera;
    }

    takeDamage(amount, attacker = null) {
        if (!this.survivalMode || this.isDead) return;
        
        const now = performance.now ? performance.now() : Date.now();
        // Invulnerability period (0.5s)
        if (now < this.invulnerableUntil) return;
        
        // Check for wood shield reflection (3% chance)
        const offHandItem = this.equipment.offHand;
        const hasWoodShield = (offHandItem && typeof offHandItem === 'object' && offHandItem.type === 23) || offHandItem === 23;
        
        if (hasWoodShield && attacker && Math.random() < 0.03) {
            // Reflect damage back to attacker
            if (attacker.takeDamage) {
                attacker.takeDamage(amount, null); // Reflect original damage, no chain reflection
                console.log(`Wood Shield reflected ${amount} damage back to attacker!`);
            }
            return; // Don't take damage if reflected
        }
        
        // Apply armor damage reduction
        const armorReduction = this.getArmorReduction();
        const damageMultiplier = 1 - (armorReduction / 100);
        const actualDamage = amount * damageMultiplier;
        
        this.health = Math.max(0, this.health - actualDamage);
        this.invulnerableUntil = now + 500; // 500ms invulnerability
        
        // Check if attacker has a curse weapon
        if (attacker && attacker.equipment && attacker.equipment.mainHand) {
            const weaponItem = attacker.equipment.mainHand;
            if (weaponItem && typeof weaponItem === 'object' && weaponItem.hasCurse && weaponItem.curseType === 'gloom') {
                // Apply blindness curse if this is the game instance
                if (this.gameInstance && this.gameInstance.applyBlindness) {
                    this.gameInstance.applyBlindness();
                }
            }
        }
        
        if (armorReduction > 0) {
            console.log(`Player took ${actualDamage.toFixed(1)} damage (${amount} reduced by ${armorReduction}% armor)! Health: ${this.health}/${this.maxHealth}`);
        } else {
            console.log(`Player took ${actualDamage} damage! Health: ${this.health}/${this.maxHealth}`);
        }
        
        if (this.health <= 0) {
            this.isDead = true;
            console.log('Player died!');
        }
    }
}

class Pigman {
    constructor(position = new THREE.Vector3(), survivalMode = false, pigmanTexture = null, gameInstance = null) {
        this.position = position.clone();
        this.game = gameInstance; // Store game reference for model access
        this.yaw = 0;
        this.speed = 0.08; // Chase speed
        this.velocity = new THREE.Vector3(0, 0, 0);
        this.gravity = 0.015;
        this.size = { halfX: 0.3, halfY: 0.7, halfZ: 0.3 };
        this.onGround = false;
        this.jumpPower = 0.25;
        this.jumpCooldown = 350; // ms
        this.lastJumpTime = 0;
        this.mesh = null;
        this.pigmanTexture = pigmanTexture; // Store texture reference
        
        // Survival mode
        this.survivalMode = survivalMode;
        this.maxHealth = 15;
        this.health = 15;
        this.isDead = false;
        this.attackDamage = 2;
        this.attackCooldown = 1000; // ms between attacks
        this.lastAttackTime = 0;
        this.isAggressive = false; // Only attack if player hits them first
        this.wanderDir = new THREE.Vector3(0, 0, 0);
        this.nextWanderChange = 0;
        this.wanderSpeed = 0.03;
        
        // Damage flash effect
        this.damageFlashUntil = 0;
        this.originalMaterials = [];
    }

    createMesh() {
        // Try to use the loaded 3D model if available
        if (this.game && this.game.pigmanModelTemplate) {
            console.log('[Pigman] Using 3D model for pigman');
            const group = this.game.pigmanModelTemplate.clone();
            group.position.copy(this.position);
            this.mesh = group;
            
            // Store materials for damage flash effect
            this.originalMaterials = [];
            group.traverse(child => {
                if (child.isMesh) {
                    this.originalMaterials.push({
                        mesh: child,
                        material: child.material
                    });
                }
            });
            
            return group;
        }
        
        console.log('[Pigman] 3D model not available yet, using fallback. game:', !!this.game, 'template:', this.game ? !!this.game.pigmanModelTemplate : 'N/A');

        // Fallback to box geometry if model not loaded
        const group = new THREE.Group();

        // Use pigman texture if available, otherwise use solid colors
        const skin = this.pigmanTexture ? 
            new THREE.MeshLambertMaterial({ map: this.pigmanTexture }) :
            new THREE.MeshLambertMaterial({ color: 0xd28a7c });
        const cloth = new THREE.MeshLambertMaterial({ color: 0x444444 });

        // Torso
        const torsoGeo = new THREE.BoxGeometry(0.7, 0.9, 0.4);
        const torso = new THREE.Mesh(torsoGeo, skin);
        torso.castShadow = true;
        group.add(torso);

        // Head
        const headGeo = new THREE.BoxGeometry(0.55, 0.55, 0.55);
        const head = new THREE.Mesh(headGeo, skin);
        head.position.y = 0.9;
        head.castShadow = true;
        group.add(head);

        // Legs
        const legGeo = new THREE.BoxGeometry(0.25, 0.6, 0.25);
        const legOffsets = [-0.18, 0.18];
        legOffsets.forEach(x => {
            const leg = new THREE.Mesh(legGeo, cloth);
            leg.position.set(x, -0.75, 0);
            leg.castShadow = true;
            group.add(leg);
        });

        // Arms
        const armGeo = new THREE.BoxGeometry(0.2, 0.55, 0.2);
        const armOffsets = [-0.5, 0.5];
        armOffsets.forEach(x => {
            const arm = new THREE.Mesh(armGeo, skin);
            arm.position.set(x, 0.1, 0);
            arm.castShadow = true;
            group.add(arm);
        });

        // Eyes - white eyes with black dots
        const eyeWhite = new THREE.MeshBasicMaterial({ color: 0xffffff });
        const eyeBlack = new THREE.MeshBasicMaterial({ color: 0x000000 });
        
        // Left eye white
        const eyeGeo = new THREE.SphereGeometry(0.10, 8, 8);
        const leftEye = new THREE.Mesh(eyeGeo, eyeWhite);
        leftEye.position.set(-0.12, 1.05, 0.28);
        leftEye.castShadow = false;
        group.add(leftEye);
        
        // Left pupil (black dot)
        const leftPupil = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), eyeBlack);
        leftPupil.position.set(-0.12, 1.05, 0.33);
        leftPupil.castShadow = false;
        group.add(leftPupil);
        
        // Right eye white
        const rightEye = new THREE.Mesh(eyeGeo, eyeWhite);
        rightEye.position.set(0.12, 1.05, 0.28);
        rightEye.castShadow = false;
        group.add(rightEye);
        
        // Right pupil (black dot)
        const rightPupil = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), eyeBlack);
        rightPupil.position.set(0.12, 1.05, 0.33);
        rightPupil.castShadow = false;
        group.add(rightPupil);

        // Snout (small cone protruding from face)
        const snoutGeo = new THREE.ConeGeometry(0.1, 0.15, 8);
        const snout = new THREE.Mesh(snoutGeo, skin);
        snout.position.set(0, 0.8, 0.35);
        snout.rotation.x = -Math.PI / 2; // Point forward
        snout.castShadow = false;
        group.add(snout);

        group.position.copy(this.position);
        this.mesh = group;

        // Store original materials for damage flash
        this.originalMaterials = [];
        group.traverse(child => {
            if (child.isMesh) {
                this.originalMaterials.push({
                    mesh: child,
                    material: child.material
                });
            }
        });

        return group;
    }

    update(world, targetPlayer, deltaTime) {
        if (!world || !targetPlayer) return;

        const debugStart = performance.now();
        const now = performance.now ? performance.now() : Date.now();
        const { halfX, halfY, halfZ } = this.size;

        const checkGround = () => {
            const sampleOffsets = [0, -0.25, 0.25];
            const feetY = this.position.y - halfY;
            let highestTop = -Infinity;

            for (const ox of sampleOffsets) {
                for (const oz of sampleOffsets) {
                    const bx = Math.floor(this.position.x + ox);
                    const bz = Math.floor(this.position.z + oz);
                    const by = Math.floor(feetY - 0.05);
                    if (!world.isBlockSolid(world.getBlock(bx, by, bz))) continue;
                    const top = by + 1;
                    if (top > highestTop) highestTop = top;
                }
            }

            if (highestTop !== -Infinity) {
                const gap = highestTop - feetY;
                if (gap >= -0.08 && gap <= 0.25) {
                    this.position.y = highestTop + halfY + 0.001;
                    this.velocity.y = Math.max(this.velocity.y, 0);
                    return true;
                }
            }
            return false;
        };

        // Keep grounded state stable before applying gravity
        this.onGround = checkGround();

        // Apply gravity
        if (!this.onGround) {
            this.velocity.y -= this.gravity;
        }

        const nowMove = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

        // Movement: wander when passive, chase when aggressive
        let horizontal = new THREE.Vector3();
        if (this.isAggressive) {
            const toPlayer = targetPlayer.position.clone().sub(this.position);
            horizontal.set(toPlayer.x, 0, toPlayer.z);
        } else {
            // Refresh wander direction occasionally
            if (nowMove >= this.nextWanderChange) {
                const wanderStart = performance.now();
                const pause = Math.random() < 0.25;
                if (pause) {
                    this.wanderDir = new THREE.Vector3(0, 0, 0);
                } else {
                    const angle = Math.random() * Math.PI * 2;
                    this.wanderDir = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
                }
                this.nextWanderChange = nowMove + 1500 + Math.random() * 2000;
                const wanderElapsed = performance.now() - wanderStart;
                if (wanderElapsed > 10) console.log(`[PERF] Pigman wander change took ${wanderElapsed.toFixed(2)}ms`);
            }
            horizontal.copy(this.wanderDir);
        }

        const distance = horizontal.length();
        if (distance > 0.05) {
            horizontal.normalize();
            const moveSpeed = this.isAggressive ? this.speed : this.wanderSpeed;
            const step = moveSpeed * Math.max(deltaTime * 60, 1); // scale for frame time
            this.velocity.x = horizontal.x * step;
            this.velocity.z = horizontal.z * step;
            this.yaw = Math.atan2(horizontal.x, horizontal.z);
        } else {
            this.velocity.x *= 0.6;
            this.velocity.z *= 0.6;
        }

        // Attempt a small hop over single-block obstacles while moving
        if (this.onGround && distance > 0.05) {
            const forward = horizontal.lengthSq() > 0 ? horizontal.clone().normalize() : null;
            if (forward) {
                const probeX = this.position.x + forward.x * (halfX + 0.25);
                const probeZ = this.position.z + forward.z * (halfZ + 0.25);
                const footY = Math.floor(this.position.y - halfY - 0.01);
                const headY = Math.floor(this.position.y + halfY + 0.2);
                const baseBlock = world.getBlock(Math.floor(probeX), footY, Math.floor(probeZ));
                const aboveBlock = world.getBlock(Math.floor(probeX), footY + 1, Math.floor(probeZ));
                const headClear = !world.isBlockSolid(world.getBlock(Math.floor(probeX), headY, Math.floor(probeZ)));

                if (world.isBlockSolid(baseBlock) && !world.isBlockSolid(aboveBlock) && headClear) {
                    if (nowMove - this.lastJumpTime >= this.jumpCooldown) {
                        this.velocity.y = this.jumpPower;
                        this.onGround = false;
                        this.lastJumpTime = nowMove;
                    }
                }
            }
        }

        // Simple collision helper
        const isSolidAt = (pos) => world.isBlockSolid(world.getBlock(Math.floor(pos[0]), Math.floor(pos[1]), Math.floor(pos[2])));
        const hasCollision = (pos) => {
            const pts = [
                [pos.x - halfX, pos.y - halfY, pos.z - halfZ],
                [pos.x + halfX, pos.y - halfY, pos.z - halfZ],
                [pos.x - halfX, pos.y + halfY, pos.z - halfZ],
                [pos.x + halfX, pos.y + halfY, pos.z - halfZ],
                [pos.x - halfX, pos.y - halfY, pos.z + halfZ],
                [pos.x + halfX, pos.y - halfY, pos.z + halfZ],
                [pos.x - halfX, pos.y + halfY, pos.z + halfZ],
                [pos.x + halfX, pos.y + halfY, pos.z + halfZ]
            ];
            for (const p of pts) if (isSolidAt(p)) return true;
            return false;
        };

        const nextPos = this.position.clone();
        // Horizontal X
        nextPos.x += this.velocity.x;
        if (!hasCollision(nextPos)) {
            this.position.x = nextPos.x;
        } else {
            this.velocity.x = 0;
        }

        // Horizontal Z
        nextPos.z = this.position.z + this.velocity.z;
        nextPos.x = this.position.x; // reset X to accepted value
        if (!hasCollision(nextPos)) {
            this.position.z = nextPos.z;
        } else {
            this.velocity.z = 0;
        }

        // Vertical
        nextPos.y = this.position.y + this.velocity.y;
        nextPos.x = this.position.x;
        nextPos.z = this.position.z;
        let landed = false;
        if (!hasCollision(nextPos)) {
            this.position.y = nextPos.y;
        } else {
            // If falling onto ground, snap to top of block
            if (this.velocity.y < 0) {
                const feetY = this.position.y - halfY;
                const by = Math.floor(feetY - 0.01);
                const bx = Math.floor(this.position.x);
                const bz = Math.floor(this.position.z);
                if (world.isBlockSolid(world.getBlock(bx, by, bz))) {
                    this.position.y = by + 1 + halfY + 0.001;
                }
                landed = true;
            }
            this.velocity.y = 0;
        }

        // Refresh grounded state after movement to keep gravity/jumps stable
        this.onGround = landed || checkGround();

        // Attack player only if aggressive (i.e., player hit them first)
        if (this.survivalMode && this.isAggressive && targetPlayer && !targetPlayer.isDead) {
            const dist = this.position.distanceTo(targetPlayer.position);
            if (dist < 2.0) { // Attack range
                if (now - this.lastAttackTime >= this.attackCooldown) {
                    targetPlayer.takeDamage(this.attackDamage, this);
                    this.lastAttackTime = now;
                }
            }
        }

        // Idle bobbing visual only when on ground
        const t = (performance.now ? performance.now() : Date.now()) * 0.001;
        const bob = this.onGround ? Math.sin(t * 4) * 0.05 : 0;

        // Update damage flash effect using emissive, not new materials
        if (now < this.damageFlashUntil) {
            // Flash red using emissive
            if (this.mesh) {
                this.mesh.traverse(child => {
                    if (child.isMesh && child.material) {
                        child.material.emissive.setHex(0xff0000);
                        child.material.emissiveIntensity = 0.8;
                    }
                });
            }
            
        } else if (this.damageFlashUntil > 0) {
            // Restore original emissive
            if (this.mesh) {
                this.mesh.traverse(child => {
                    if (child.isMesh && child.material) {
                        child.material.emissive.setHex(0x000000);
                        child.material.emissiveIntensity = 0;
                    }
                });
            }
            this.damageFlashUntil = 0;
        }

        if (this.mesh) {
            this.mesh.position.set(this.position.x, this.position.y + bob, this.position.z);
            this.mesh.rotation.y = this.yaw;
        }
        
        const totalElapsed = performance.now() - debugStart;
        if (totalElapsed > 20) {
            console.warn(`[PERF] Pigman.update() took ${totalElapsed.toFixed(2)}ms`);
        }
    }

    takeDamage(amount, knockbackDir = null) {
        if (!this.survivalMode || this.isDead) return false;
        
        this.health = Math.max(0, this.health - amount);
        this.isAggressive = true; // Become aggressive when hit
        console.log(`Pigman took ${amount} damage! Health: ${this.health}/${this.maxHealth}`);
        
        // Apply red flash effect for 200ms
        const now = performance.now ? performance.now() : Date.now();
        this.damageFlashUntil = now + 200;
        
        // Apply knockback
        if (knockbackDir) {
            const knockbackStrength = 0.3;
            this.velocity.x = knockbackDir.x * knockbackStrength;
            this.velocity.z = knockbackDir.z * knockbackStrength;
            this.velocity.y = 0.15; // Small upward boost
        }
        
        if (this.health <= 0) {
            this.isDead = true;
            console.log('Pigman died!');
            return true; // Died
        }
        return false; // Still alive
    }
}

class PigmanPriest {
    constructor(position = new THREE.Vector3(), survivalMode = false) {
        this.position = position.clone();
        this.yaw = 0;
        this.speed = 0.06; // Slower than regular pigman
        this.velocity = new THREE.Vector3(0, 0, 0);
        this.gravity = 0.015;
        this.size = { halfX: 0.4, halfY: 0.9, halfZ: 0.4 }; // Larger
        this.onGround = false;
        this.jumpPower = 0.3;
        this.jumpCooldown = 350;
        this.lastJumpTime = 0;
        this.mesh = null;
        
        // Boss stats
        this.survivalMode = survivalMode;
        this.maxHealth = 100; // Much tankier
        this.health = 100;
        this.isDead = false;
        this.attackDamage = 5; // Heavy damage
        this.attackCooldown = 1500;
        this.lastAttackTime = 0;
        this.isAggressive = true; // Always aggressive
        this.wanderDir = new THREE.Vector3(0, 0, 0);
        this.nextWanderChange = 0;
        this.wanderSpeed = 0.02;
        
        // Special abilities
        this.healCooldown = 8000; // Heal every 8 seconds
        this.lastHealTime = 0;
        this.healAmount = 10;
        
        this.damageFlashUntil = 0;
        this.originalMaterials = [];
    }

    createMesh() {
        const group = new THREE.Group();

        // Golden/priest colors
        const skin = new THREE.MeshLambertMaterial({ 
            color: 0xd28a7c,
            emissive: new THREE.Color(0x442200),
            emissiveIntensity: 0.3
        });
        const robes = new THREE.MeshLambertMaterial({ 
            color: 0x8B0000, // Dark red robes
            emissive: new THREE.Color(0x330000),
            emissiveIntensity: 0.4
        });
        const gold = new THREE.MeshLambertMaterial({ 
            color: 0xFFD700,
            emissive: new THREE.Color(0xFFAA00),
            emissiveIntensity: 0.6
        });

        // Larger torso
        const torsoGeo = new THREE.BoxGeometry(0.9, 1.2, 0.5);
        const torso = new THREE.Mesh(torsoGeo, robes);
        torso.castShadow = true;
        group.add(torso);

        // Larger head with crown
        const headGeo = new THREE.BoxGeometry(0.7, 0.7, 0.7);
        const head = new THREE.Mesh(headGeo, skin);
        head.position.y = 1.2;
        head.castShadow = true;
        group.add(head);

        // Crown
        const crownGeo = new THREE.BoxGeometry(0.75, 0.2, 0.75);
        const crown = new THREE.Mesh(crownGeo, gold);
        crown.position.y = 1.55;
        crown.castShadow = true;
        group.add(crown);

        // Legs
        const legGeo = new THREE.BoxGeometry(0.3, 0.7, 0.3);
        const legOffsets = [-0.25, 0.25];
        legOffsets.forEach(x => {
            const leg = new THREE.Mesh(legGeo, robes);
            leg.position.set(x, -0.95, 0);
            leg.castShadow = true;
            group.add(leg);
        });

        // Arms
        const armGeo = new THREE.BoxGeometry(0.25, 0.7, 0.25);
        const armOffsets = [-0.6, 0.6];
        armOffsets.forEach(x => {
            const arm = new THREE.Mesh(armGeo, skin);
            arm.position.set(x, 0.2, 0);
            arm.castShadow = true;
            group.add(arm);
        });

        // Staff
        const staffGeo = new THREE.BoxGeometry(0.1, 1.5, 0.1);
        const staff = new THREE.Mesh(staffGeo, gold);
        staff.position.set(-0.7, 0.5, 0);
        staff.castShadow = true;
        group.add(staff);

        // Eyes
        const eyeWhite = new THREE.MeshLambertMaterial({ color: 0xffffff });
        const eyeBlack = new THREE.MeshLambertMaterial({ color: 0x000000 });
        
        // Left eye
        const eyeGeo = new THREE.SphereGeometry(0.1, 8, 8);
        const leftEye = new THREE.Mesh(eyeGeo, eyeWhite);
        leftEye.position.set(-0.18, 1.45, 0.25);
        leftEye.castShadow = true;
        group.add(leftEye);
        
        const leftPupil = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), eyeBlack);
        leftPupil.position.set(-0.18, 1.45, 0.32);
        leftPupil.castShadow = true;
        group.add(leftPupil);
        
        // Right eye
        const rightEye = new THREE.Mesh(eyeGeo, eyeWhite);
        rightEye.position.set(0.18, 1.45, 0.25);
        rightEye.castShadow = true;
        group.add(rightEye);
        
        const rightPupil = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), eyeBlack);
        rightPupil.position.set(0.18, 1.45, 0.32);
        rightPupil.castShadow = true;
        group.add(rightPupil);

        // Add snout
        const snoutGeo = new THREE.ConeGeometry(0.1, 0.15, 8);
        const snout = new THREE.Mesh(snoutGeo, skin);
        snout.position.set(0, 1.0, 0.4);
        snout.rotation.x = -Math.PI / 2;
        snout.castShadow = true;
        group.add(snout);

        group.position.copy(this.position);
        this.mesh = group;
        
        this.originalMaterials = [];
        group.traverse(child => {
            if (child.isMesh) {
                this.originalMaterials.push({
                    mesh: child,
                    material: child.material
                });
            }
        });
        
        return this.mesh;
    }

    update(world, targetPlayer, deltaTime) {
        if (!world || !targetPlayer) return;

        const now = performance.now ? performance.now() : Date.now();
        const { halfX, halfY, halfZ } = this.size;

        const checkGround = () => {
            const sampleOffsets = [0, -0.3, 0.3];
            const feetY = this.position.y - halfY;
            let highestTop = -Infinity;

            for (const ox of sampleOffsets) {
                for (const oz of sampleOffsets) {
                    const bx = Math.floor(this.position.x + ox);
                    const bz = Math.floor(this.position.z + oz);
                    const by = Math.floor(feetY - 0.05);
                    if (!world.isBlockSolid(world.getBlock(bx, by, bz))) continue;
                    const top = by + 1;
                    if (top > highestTop) highestTop = top;
                }
            }

            if (highestTop !== -Infinity) {
                const gap = highestTop - feetY;
                if (gap >= -0.08 && gap <= 0.25) {
                    this.position.y = highestTop + halfY + 0.001;
                    this.velocity.y = Math.max(this.velocity.y, 0);
                    return true;
                }
            }
            return false;
        };

        this.onGround = checkGround();

        if (!this.onGround) {
            this.velocity.y -= this.gravity;
        }

        // Always chase player (boss is always aggressive)
        const toPlayer = targetPlayer.position.clone().sub(this.position);
        const horizontal = new THREE.Vector3(toPlayer.x, 0, toPlayer.z);
        const distance = horizontal.length();

        if (distance > 0.5) {
            horizontal.normalize();
            const step = this.speed * Math.max(deltaTime * 60, 1);
            this.velocity.x = horizontal.x * step;
            this.velocity.z = horizontal.z * step;
            this.yaw = Math.atan2(horizontal.x, horizontal.z);
        } else {
            this.velocity.x *= 0.6;
            this.velocity.z *= 0.6;
        }

        // Heal ability
        if (this.health < this.maxHealth && now - this.lastHealTime >= this.healCooldown) {
            this.health = Math.min(this.maxHealth, this.health + this.healAmount);
            this.lastHealTime = now;
            console.log(`Pigman Priest healed! Health: ${this.health}/${this.maxHealth}`);
        }

        // Simple collision
        const isSolidAt = (pos) => world.isBlockSolid(world.getBlock(Math.floor(pos[0]), Math.floor(pos[1]), Math.floor(pos[2])));
        const hasCollision = (pos) => {
            const pts = [
                [pos.x - halfX, pos.y - halfY, pos.z - halfZ],
                [pos.x + halfX, pos.y - halfY, pos.z - halfZ],
                [pos.x - halfX, pos.y + halfY, pos.z - halfZ],
                [pos.x + halfX, pos.y + halfY, pos.z - halfZ],
                [pos.x - halfX, pos.y - halfY, pos.z + halfZ],
                [pos.x + halfX, pos.y - halfY, pos.z + halfZ],
                [pos.x - halfX, pos.y + halfY, pos.z + halfZ],
                [pos.x + halfX, pos.y + halfY, pos.z + halfZ]
            ];
            for (const p of pts) if (isSolidAt(p)) return true;
            return false;
        };

        const nextPos = this.position.clone();
        nextPos.x += this.velocity.x;
        if (!hasCollision(nextPos)) {
            this.position.x = nextPos.x;
        } else {
            this.velocity.x = 0;
        }

        nextPos.z = this.position.z + this.velocity.z;
        nextPos.x = this.position.x;
        if (!hasCollision(nextPos)) {
            this.position.z = nextPos.z;
        } else {
            this.velocity.z = 0;
        }

        nextPos.y = this.position.y + this.velocity.y;
        nextPos.x = this.position.x;
        nextPos.z = this.position.z;
        let landed = false;
        if (!hasCollision(nextPos)) {
            this.position.y = nextPos.y;
        } else {
            if (this.velocity.y < 0) {
                const feetY = this.position.y - halfY;
                const by = Math.floor(feetY - 0.01);
                const bx = Math.floor(this.position.x);
                const bz = Math.floor(this.position.z);
                if (world.isBlockSolid(world.getBlock(bx, by, bz))) {
                    this.position.y = by + 1 + halfY + 0.001;
                }
                landed = true;
            }
            this.velocity.y = 0;
        }

        this.onGround = landed || checkGround();

        // Attack player
        if (this.survivalMode && targetPlayer && !targetPlayer.isDead) {
            const dist = this.position.distanceTo(targetPlayer.position);
            if (dist < 2.5) {
                if (now - this.lastAttackTime >= this.attackCooldown) {
                    targetPlayer.takeDamage(this.attackDamage, this);
                    this.lastAttackTime = now;
                    console.log('Pigman Priest attacked!');
                }
            }
        }

        const t = (performance.now ? performance.now() : Date.now()) * 0.001;
        const bob = this.onGround ? Math.sin(t * 3) * 0.08 : 0;

        // Damage flash
        if (now < this.damageFlashUntil) {
            if (this.mesh) {
                this.mesh.traverse(child => {
                    if (child.isMesh && child.material) {
                        child.material.emissive.setHex(0xff0000);
                        child.material.emissiveIntensity = 1.0;
                    }
                });
            }
        } else if (this.damageFlashUntil > 0) {
            if (this.mesh) {
                this.mesh.traverse(child => {
                    if (child.isMesh && child.material) {
                        // Restore original emissive (golden glow)
                        if (child.material.color.getHex() === 0xFFD700) {
                            child.material.emissive.setHex(0xFFAA00);
                            child.material.emissiveIntensity = 0.6;
                        } else {
                            child.material.emissive.setHex(0x000000);
                            child.material.emissiveIntensity = 0;
                        }
                    }
                });
            }
            this.damageFlashUntil = 0;
        }

        if (this.mesh) {
            this.mesh.position.set(this.position.x, this.position.y + bob, this.position.z);
            this.mesh.rotation.y = this.yaw;
        }
    }

    takeDamage(amount, knockbackDir = null) {
        if (!this.survivalMode || this.isDead) return false;
        
        this.health = Math.max(0, this.health - amount);
        console.log(`Pigman Priest took ${amount} damage! Health: ${this.health}/${this.maxHealth}`);
        
        const now = performance.now ? performance.now() : Date.now();
        this.damageFlashUntil = now + 200;
        
        if (knockbackDir) {
            const knockbackStrength = 0.2; // Boss is heavier, less knockback
            this.velocity.x = knockbackDir.x * knockbackStrength;
            this.velocity.z = knockbackDir.z * knockbackStrength;
            this.velocity.y = 0.1;
        }
        
        if (this.health <= 0) {
            this.isDead = true;
            console.log('Pigman Priest defeated!');
            return true;
        }
        return false;
    }
}

class Minutor {
    constructor(position = new THREE.Vector3(), survivalMode = false) {
        this.position = position.clone();
        this.yaw = 0;
        this.speed = 0.07; // Slow but powerful
        this.velocity = new THREE.Vector3(0, 0, 0);
        this.gravity = 0.015;
        this.size = { halfX: 0.4, halfY: 0.9, halfZ: 0.4 }; // Larger than Pigman
        this.onGround = false;
        this.jumpPower = 0.3;
        this.jumpCooldown = 300; // ms
        this.lastJumpTime = 0;
        this.mesh = null;
        
        // Survival mode
        this.survivalMode = survivalMode;
        this.maxHealth = 20;
        this.health = 20;
        this.isDead = false;
        this.attackDamage = 15;
        this.attackCooldown = 1200; // ms between attacks
        this.lastAttackTime = 0;
        this.isAggressive = true; // Always aggressive (unlike Pigman)
        this.wanderDir = new THREE.Vector3(0, 0, 0);
        this.nextWanderChange = 0;
        this.wanderSpeed = 0.04;
        
        // Damage flash effect
        this.damageFlashUntil = 0;
        this.originalMaterials = [];
    }

    createMesh() {
        const group = new THREE.Group();

        // Dark brown/black skin for a menacing look
        const skin = new THREE.MeshLambertMaterial({ color: 0x2a1810 });
        const accent = new THREE.MeshLambertMaterial({ color: 0x8B0000 }); // Dark red accents

        // Larger torso
        const torsoGeo = new THREE.BoxGeometry(0.9, 1.2, 0.5);
        const torso = new THREE.Mesh(torsoGeo, skin);
        torso.castShadow = true;
        group.add(torso);

        // Bull-like head with horns
        const headGeo = new THREE.BoxGeometry(0.7, 0.7, 0.7);
        const head = new THREE.Mesh(headGeo, skin);
        head.position.y = 1.2;
        head.castShadow = true;
        group.add(head);

        // Horns
        const hornGeo = new THREE.ConeGeometry(0.08, 0.4, 6);
        const hornMat = new THREE.MeshLambertMaterial({ color: 0xcccccc });
        const hornLeft = new THREE.Mesh(hornGeo, hornMat);
        hornLeft.position.set(-0.3, 1.5, 0);
        hornLeft.rotation.z = Math.PI / 6;
        hornLeft.castShadow = true;
        group.add(hornLeft);
        
        const hornRight = new THREE.Mesh(hornGeo, hornMat);
        hornRight.position.set(0.3, 1.5, 0);
        hornRight.rotation.z = -Math.PI / 6;
        hornRight.castShadow = true;
        group.add(hornRight);

        // Legs
        const legGeo = new THREE.BoxGeometry(0.3, 0.8, 0.3);
        const legOffsets = [-0.25, 0.25];
        legOffsets.forEach(x => {
            const leg = new THREE.Mesh(legGeo, accent);
            leg.position.set(x, -1.0, 0);
            leg.castShadow = true;
            group.add(leg);
        });

        // Arms
        const armGeo = new THREE.BoxGeometry(0.25, 0.7, 0.25);
        const armOffsets = [-0.6, 0.6];
        armOffsets.forEach(x => {
            const arm = new THREE.Mesh(armGeo, accent);
            arm.position.set(x, 0.2, 0);
            arm.castShadow = true;
            group.add(arm);
        });

        // Red eyes (just red, no pupils)
        const eyeRed = new THREE.MeshLambertMaterial({ color: 0xff0000 });
        
        // Left eye
        const eyeGeo = new THREE.SphereGeometry(0.1, 8, 8);
        const leftEye = new THREE.Mesh(eyeGeo, eyeRed);
        leftEye.position.set(-0.18, 1.45, 0.36);
        leftEye.castShadow = true;
        group.add(leftEye);
        
        // Right eye
        const rightEye = new THREE.Mesh(eyeGeo, eyeRed);
        rightEye.position.set(0.18, 1.45, 0.36);
        rightEye.castShadow = true;
        group.add(rightEye);

        group.position.copy(this.position);
        this.mesh = group;
        
        // Store original materials for damage flash
        this.originalMaterials = [];
        group.traverse(child => {
            if (child.isMesh) {
                this.originalMaterials.push({
                    mesh: child,
                    material: child.material
                });
            }
        });
        
        return group;
    }

    update(world, targetPlayer, deltaTime) {
        if (!world || !targetPlayer) return;

        const debugStart = performance.now();
        const now = performance.now ? performance.now() : Date.now();
        const { halfX, halfY, halfZ } = this.size;

        const checkGround = () => {
            const sampleOffsets = [0, -0.25, 0.25];
            const feetY = this.position.y - halfY;
            let highestTop = -Infinity;

            for (const ox of sampleOffsets) {
                for (const oz of sampleOffsets) {
                    const bx = Math.floor(this.position.x + ox);
                    const bz = Math.floor(this.position.z + oz);
                    const by = Math.floor(feetY - 0.05);
                    if (!world.isBlockSolid(world.getBlock(bx, by, bz))) continue;
                    const top = by + 1;
                    if (top > highestTop) highestTop = top;
                }
            }

            if (highestTop !== -Infinity) {
                const gap = highestTop - feetY;
                if (gap >= -0.08 && gap <= 0.25) {
                    this.position.y = highestTop + halfY + 0.001;
                    this.velocity.y = Math.max(this.velocity.y, 0);
                    return true;
                }
            }
            return false;
        };

        // Keep grounded state stable before applying gravity
        this.onGround = checkGround();

        // Apply gravity
        if (!this.onGround) {
            this.velocity.y -= this.gravity;
        }

        const nowMove = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

        // Check if player is visible (line of sight)
        const toPlayer = targetPlayer.position.clone().sub(this.position);
        const distanceToPlayer = toPlayer.length();
        let canSeePlayer = false;

        if (distanceToPlayer < 20) { // Only check line of sight within 20 blocks
            const steps = Math.ceil(distanceToPlayer);
            const stepDir = toPlayer.clone().normalize();
            let blocked = false;

            for (let i = 1; i < steps; i++) {
                const checkPos = this.position.clone().addScaledVector(stepDir, i);
                const bx = Math.floor(checkPos.x);
                const by = Math.floor(checkPos.y);
                const bz = Math.floor(checkPos.z);
                
                if (world.isBlockSolid(world.getBlock(bx, by, bz))) {
                    blocked = true;
                    break;
                }
            }
            canSeePlayer = !blocked;
        }

        // Chase player only if visible, otherwise wander
        let horizontal = new THREE.Vector3();
        if (canSeePlayer) {
            horizontal.set(toPlayer.x, 0, toPlayer.z);
        } else {
            // Wander when player not visible
            if (nowMove >= this.nextWanderChange) {
                const pause = Math.random() < 0.25;
                if (pause) {
                    this.wanderDir = new THREE.Vector3(0, 0, 0);
                } else {
                    const angle = Math.random() * Math.PI * 2;
                    this.wanderDir = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
                }
                this.nextWanderChange = nowMove + 1500 + Math.random() * 2000;
            }
            horizontal.copy(this.wanderDir);
        }

        const distance = horizontal.length();
        if (distance > 0.05) {
            horizontal.normalize();
            const moveSpeed = canSeePlayer ? this.speed : this.wanderSpeed;
            const step = moveSpeed * Math.max(deltaTime * 60, 1);
            this.velocity.x = horizontal.x * step;
            this.velocity.z = horizontal.z * step;
            this.yaw = Math.atan2(horizontal.x, horizontal.z);
        } else {
            this.velocity.x *= 0.6;
            this.velocity.z *= 0.6;
        }

        // Attempt a small hop over single-block obstacles while moving
        if (this.onGround && distance > 0.05) {
            const lookX = Math.sin(this.yaw) * 0.6;
            const lookZ = Math.cos(this.yaw) * 0.6;
            const feetY = this.position.y - halfY;
            const floorY = Math.floor(feetY);
            const bx = Math.floor(this.position.x + lookX);
            const bz = Math.floor(this.position.z + lookZ);
            
            const blockInFront = world.getBlock(bx, floorY, bz);
            const blockAbove = world.getBlock(bx, floorY + 1, bz);
            
            if (world.isBlockSolid(blockInFront) && !world.isBlockSolid(blockAbove)) {
                if (now - this.lastJumpTime >= this.jumpCooldown) {
                    this.velocity.y = this.jumpPower;
                    this.lastJumpTime = now;
                }
            }
        }

        // Collision detection
        const hasCollision = (testPos) => {
            const offsets = [
                [-halfX, -halfY, -halfZ], [halfX, -halfY, -halfZ],
                [-halfX, -halfY, halfZ], [halfX, -halfY, halfZ],
                [-halfX, halfY, -halfZ], [halfX, halfY, -halfZ],
                [-halfX, halfY, halfZ], [halfX, halfY, halfZ]
            ];
            for (const [ox, oy, oz] of offsets) {
                const px = testPos.x + ox;
                const py = testPos.y + oy;
                const pz = testPos.z + oz;
                const bx = Math.floor(px);
                const by = Math.floor(py);
                const bz = Math.floor(pz);
                if (world.isBlockSolid(world.getBlock(bx, by, bz))) return true;
            }
            return false;
        };

        // X movement
        let nextPos = this.position.clone();
        nextPos.x += this.velocity.x;
        if (!hasCollision(nextPos)) {
            this.position.x = nextPos.x;
        } else {
            this.velocity.x = 0;
        }

        // Z movement
        nextPos = this.position.clone();
        nextPos.z += this.velocity.z;
        if (!hasCollision(nextPos)) {
            this.position.z = nextPos.z;
        } else {
            this.velocity.z = 0;
        }

        // Y movement
        nextPos = this.position.clone();
        nextPos.y += this.velocity.y;
        let landed = false;
        if (!hasCollision(nextPos)) {
            this.position.y = nextPos.y;
        } else {
            if (this.velocity.y < 0) {
                const feetY = this.position.y - halfY;
                const by = Math.floor(feetY - 0.01);
                const bx = Math.floor(this.position.x);
                const bz = Math.floor(this.position.z);
                if (world.isBlockSolid(world.getBlock(bx, by, bz))) {
                    this.position.y = by + 1 + halfY + 0.001;
                }
                landed = true;
            }
            this.velocity.y = 0;
        }

        this.onGround = landed || checkGround();

        // Attack player only if visible
        if (this.survivalMode && !targetPlayer.isDead && canSeePlayer) {
            const dist = this.position.distanceTo(targetPlayer.position);
            if (dist < 2.5) { // Slightly longer attack range
                if (now - this.lastAttackTime >= this.attackCooldown) {
                    targetPlayer.takeDamage(this.attackDamage, this);
                    this.lastAttackTime = now;
                }
            }
        }

        // Idle bobbing visual only when on ground
        const t = (performance.now ? performance.now() : Date.now()) * 0.001;
        const bob = this.onGround ? Math.sin(t * 4) * 0.05 : 0;

        // Update damage flash effect
        if (now < this.damageFlashUntil) {
            if (this.mesh) {
                this.mesh.traverse(child => {
                    if (child.isMesh && child.material) {
                        child.material.emissive.setHex(0xff0000);
                        child.material.emissiveIntensity = 0.8;
                    }
                });
            }
        } else if (this.damageFlashUntil > 0) {
            if (this.mesh) {
                this.mesh.traverse(child => {
                    if (child.isMesh && child.material) {
                        child.material.emissive.setHex(0x000000);
                        child.material.emissiveIntensity = 0;
                    }
                });
            }
            this.damageFlashUntil = 0;
        }

        if (this.mesh) {
            this.mesh.position.copy(this.position);
            this.mesh.position.y += bob;
            this.mesh.rotation.y = this.yaw;
        }

        const debugElapsed = performance.now() - debugStart;
        if (debugElapsed > 10) {
            console.log(`[PERF] Minutor update took ${debugElapsed.toFixed(2)}ms`);
        }
    }

    takeDamage(amount, knockbackDir = null) {
        if (!this.survivalMode || this.isDead) return false;
        
        this.health = Math.max(0, this.health - amount);
        console.log(`Minutor took ${amount} damage! Health: ${this.health}/${this.maxHealth}`);
        
        // Apply red flash effect for 200ms
        const now = performance.now ? performance.now() : Date.now();
        this.damageFlashUntil = now + 200;
        
        // Apply knockback
        if (knockbackDir) {
            const knockbackStrength = 0.25; // Slightly harder to knockback
            this.velocity.x = knockbackDir.x * knockbackStrength;
            this.velocity.z = knockbackDir.z * knockbackStrength;
            this.velocity.y = 0.12;
        }
        
        if (this.health <= 0) {
            this.isDead = true;
            console.log('Minutor died!');
            return true; // Died
        }
        return false; // Still alive
    }
}

class Phinox {
    constructor(position = new THREE.Vector3()) {
        this.position = position.clone();
        this.yaw = 0;
        this.velocity = new THREE.Vector3(0, 0, 0);
        this.size = { halfX: 0.6, halfY: 0.6, halfZ: 0.6 };
        this.mesh = null;
        this.isMounted = false;
        this.rider = null;
        this.flySpeed = 0.25;
        this.hoverHeight = 0;
        this.spawnTime = performance.now();
    }

    createMesh() {
        const group = new THREE.Group();

        const fireMat = new THREE.MeshStandardMaterial({ 
            color: 0xff4500, 
            emissive: 0xff6600,
            emissiveIntensity: 1.5
        });
        const glowMat = new THREE.MeshStandardMaterial({ 
            color: 0xffaa00, 
            emissive: 0xff8800,
            emissiveIntensity: 2.0
        });

        const bodyGeo = new THREE.BoxGeometry(0.8, 0.6, 1.2);
        const body = new THREE.Mesh(bodyGeo, fireMat);
        body.castShadow = true;
        group.add(body);

        const headGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
        const head = new THREE.Mesh(headGeo, glowMat);
        head.position.set(0, 0.3, -0.7);
        head.castShadow = true;
        group.add(head);

        // Eyes - two black dots (positioned on front face at -Z)
        const eyeBlack = new THREE.MeshBasicMaterial({ color: 0x000000 });
        const eyeGeo = new THREE.SphereGeometry(0.08, 8, 8);
        
        const leftEye = new THREE.Mesh(eyeGeo, eyeBlack);
        leftEye.position.set(-0.15, 0.35, -0.95);
        group.add(leftEye);
        
        const rightEye = new THREE.Mesh(eyeGeo, eyeBlack);
        rightEye.position.set(0.15, 0.35, -0.95);
        group.add(rightEye);

        const wingGeo = new THREE.BoxGeometry(1.5, 0.1, 0.8);
        const leftWing = new THREE.Mesh(wingGeo, fireMat);
        leftWing.position.set(-1.0, 0.2, 0);
        leftWing.castShadow = true;
        group.add(leftWing);

        const rightWing = new THREE.Mesh(wingGeo, fireMat);
        rightWing.position.set(1.0, 0.2, 0);
        rightWing.castShadow = true;
        group.add(rightWing);

        const tailGeo = new THREE.BoxGeometry(0.4, 0.3, 1.0);
        const tail = new THREE.Mesh(tailGeo, glowMat);
        tail.position.set(0, 0, -0.8);
        tail.castShadow = true;
        group.add(tail);

        this.leftWing = leftWing;
        this.rightWing = rightWing;

        group.position.copy(this.position);
        this.mesh = group;
    }

    update(deltaTime, playerInput = null, world = null) {
        if (!this.mesh) return;

        const now = performance.now();
        const flapSpeed = this.isMounted ? 8 : 4;
        const flapAngle = Math.sin(now * 0.01 * flapSpeed) * 0.3;
        if (this.leftWing) this.leftWing.rotation.z = flapAngle;
        if (this.rightWing) this.rightWing.rotation.z = -flapAngle;

        if (this.isMounted && playerInput) {
            const forward = new THREE.Vector3(0, 0, -1);
            forward.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);

            const right = new THREE.Vector3(1, 0, 0);
            right.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);

            this.velocity.set(0, 0, 0);

            if (playerInput.forward) {
                this.velocity.add(forward.multiplyScalar(this.flySpeed));
            }
            if (playerInput.backward) {
                this.velocity.add(forward.multiplyScalar(-this.flySpeed * 0.5));
            }
            if (playerInput.left) {
                this.velocity.add(right.clone().multiplyScalar(-this.flySpeed * 0.7));
            }
            if (playerInput.right) {
                this.velocity.add(right.clone().multiplyScalar(this.flySpeed * 0.7));
            }
            if (playerInput.jump) {
                this.velocity.y = this.flySpeed * 0.8;
            }
            if (playerInput.sneak) {
                this.velocity.y = -this.flySpeed * 0.8;
            }

            // Apply velocity with collision detection
            const testPos = this.position.clone().add(this.velocity);
            
            if (world) {
                // Check collision with block at new position (using Phinox size)
                const { halfX, halfY, halfZ } = this.size;
                
                // Sample corners to check for solid blocks
                const corners = [
                    [testPos.x - halfX, testPos.y - halfY, testPos.z - halfZ],
                    [testPos.x + halfX, testPos.y + halfY, testPos.z + halfZ],
                    [testPos.x - halfX, testPos.y + halfY, testPos.z - halfZ],
                    [testPos.x + halfX, testPos.y - halfY, testPos.z + halfZ]
                ];
                
                let canMove = true;
                for (const [x, y, z] of corners) {
                    const block = world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
                    if (world.isBlockSolid(block)) {
                        canMove = false;
                        break;
                    }
                }
                
                if (canMove) {
                    this.position.copy(testPos);
                }
            } else {
                this.position.add(this.velocity);
            }
        } else {
            this.hoverHeight = Math.sin((now - this.spawnTime) * 0.002) * 0.15;
            this.position.y += this.hoverHeight * deltaTime * 60;
        }

        this.mesh.position.copy(this.position);
        this.mesh.rotation.y = this.yaw;
    }

    mount(player) {
        this.isMounted = true;
        this.rider = player;
    }

    dismount() {
        this.isMounted = false;
        this.rider = null;
    }
}


class Item {
    constructor(type, amount = 1) {
        this.type = type;
        this.amount = amount;
        this.maxStack = 99;
    }

    canStack(otherItem) {
        return otherItem && otherItem.type === this.type && this.amount < this.maxStack;
    }

    addAmount(amt) {
        const space = this.maxStack - this.amount;
        const toAdd = Math.min(space, amt);
        this.amount += toAdd;
        return amt - toAdd; // Return remaining amount that couldn't be added
    }

    removeAmount(amt) {
        const toRemove = Math.min(this.amount, amt);
        this.amount -= toRemove;
        return toRemove;
    }

    isEmpty() {
        return this.amount <= 0;
    }

    clone() {
        return new Item(this.type, this.amount);
    }
}

class DroppedItem {
    constructor(position, itemType, amount = 1) {
        this.position = position.clone();
        this.itemType = itemType;
        this.amount = amount;
        this.velocity = new THREE.Vector3(
            (Math.random() - 0.5) * 0.1,
            0.2,
            (Math.random() - 0.5) * 0.1
        );
        this.gravity = 0.015;
        this.onGround = false;
        this.lifetime = 0; // Track lifetime for despawn (300 seconds = 5 minutes)
        this.maxLifetime = 300;
        this.sprite = null;
        this.bobOffset = Math.random() * Math.PI * 2; // Random bob phase
    }

    createSprite(textureAtlas, blockNames, itemTexture) {
        // Create a 2D sprite for the dropped item using individual PNG texture
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');

        // If item texture exists, draw it; otherwise use colored squares
        if (itemTexture && itemTexture.image) {
            // Draw the entire item PNG (16x16) at native size
            ctx.imageSmoothingEnabled = false; // Pixelated look
            ctx.drawImage(
                itemTexture.image,
                0, 0, 16, 16,  // Source entire image
                24, 24, 16, 16 // Draw to canvas centered at native 16x16
            );
        } else {
            // Fallback: colored squares
            const colors = {
                1: '#8B4513',  // Dirt
                2: '#228B22',  // Grass
                3: '#808080',  // Stone
                4: '#F4D03F',  // Sand
                5: '#0099FF',  // Water
                6: '#CD853F',  // Wood
                7: '#A0523D',  // Bricks
                8: '#E81828',  // Ruby
                9: '#D4623D',  // Clay
                10: '#F0F8FF', // Snow
                11: '#228B22', // Leafs
                12: '#0047AB', // Sapphire
                13: '#D2B48C', // Plank
                14: '#FFFFFF', // Paper
                15: '#8B4513', // Stick
                16: '#F5DEB3', // Scroll
                17: '#FFC0CB', // Pork
                18: '#8B4726', // Leather Helmet (brown leather)
                19: '#8B4726', // Leather Chestplate
                20: '#8B4726', // Leather Leggings
                21: '#8B4726', // Leather Boots
                22: '#708090', // Stone Sword (slate gray)
                23: '#DEB887', // Wood Shield (burlywood)
                24: '#000000', // Coal (black)
                25: '#FFD700', // Torch (golden yellow)
                26: '#8B4513', // Chest (brown wood)
                27: '#9370DB', // Mana Orb (medium purple)
                28: '#FFD700', // Fortitudo Scroll (golden yellow)
                29: '#87CEEB', // Magic candle (sky blue)
                30: '#696969', // Chisel (dim gray)
                31: '#F0F8FF', // Cloud Pillow (alice blue)
                32: '#FFD700', // Golden Sword (gold)
                33: '#2c2c2c', // Grim Stone (very dark gray)
                34: '#FF4500', // Lava (orange-red)
                35: '#FFB6C1', // Smiteth Scroll (light pink)
                36: '#1a1a2e'  // Gloom (very dark blue/black)
            };

            const color = colors[this.itemType] || '#FFFFFF';
            ctx.fillStyle = color;
            ctx.fillRect(8, 8, 48, 48);
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 2;
            ctx.strokeRect(8, 8, 48, 48);
        }

        // Add amount text if > 1
        if (this.amount > 1) {
            ctx.fillStyle = '#FFFFFF';
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 3;
            ctx.font = 'bold 20px Arial';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            ctx.strokeText(this.amount.toString(), 56, 56);
            ctx.fillText(this.amount.toString(), 56, 56);
        }

        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;

        const material = new THREE.SpriteMaterial({ 
            map: texture,
            transparent: true,
            depthTest: true,
            depthWrite: false
        });

        this.sprite = new THREE.Sprite(material);
        this.sprite.scale.set(0.4, 0.4, 1);
        this.sprite.position.copy(this.position);

        return this.sprite;
    }

    update(world, deltaTime) {
        this.lifetime += deltaTime;

        // Apply gravity
        if (!this.onGround) {
            this.velocity.y -= this.gravity;
        }

        // Apply velocity
        this.position.add(this.velocity);

        // Simple ground collision
        const groundY = Math.floor(this.position.y - 0.2);
        const groundBlock = world.getBlock(
            Math.floor(this.position.x),
            groundY,
            Math.floor(this.position.z)
        );

        if (world.isBlockSolid(groundBlock) && this.velocity.y < 0) {
            this.position.y = groundY + 1.2;
            this.velocity.y = 0;
            this.velocity.x *= 0.8;
            this.velocity.z *= 0.8;
            this.onGround = true;
        }

        // Bobbing animation
        const bobTime = (performance.now ? performance.now() : Date.now()) * 0.001;
        const bobY = Math.sin(bobTime * 2 + this.bobOffset) * 0.1;

        // Update sprite position
        if (this.sprite) {
            this.sprite.position.copy(this.position);
            this.sprite.position.y += bobY;
            
            // Slow rotation
            this.sprite.material.rotation += deltaTime * 0.5;
        }

        // Check if should despawn
        return this.lifetime < this.maxLifetime;
    }

    canPickup(playerPos, pickupRange = 1.5) {
        return this.position.distanceTo(playerPos) < pickupRange;
    }
}

class ItemManager {
    constructor(scene, world, textureAtlas, blockNames) {
        this.scene = scene;
        this.world = world;
        this.textureAtlas = textureAtlas;
        this.blockNames = blockNames;
        this.droppedItems = [];
        this.itemTextures = new Map(); // Map of itemType -> texture
        
        // Load individual item textures (item_1.png, item_2.png, etc.)
        const textureLoader = new THREE.TextureLoader();
        for (let i = 1; i <= 25; i++) {
            textureLoader.load(
                `item_${i}.png`,
                (texture) => {
                    texture.magFilter = THREE.NearestFilter;
                    texture.minFilter = THREE.NearestFilter;
                    this.itemTextures.set(i, texture);
                    console.log(`Item texture ${i} loaded successfully`);
                },
                undefined,
                (error) => {
                    console.log(`Item texture item_${i}.png not found, will use fallback colors`);
                }
            );
        }
    }

    dropItem(position, itemType, amount = 1) {
        const droppedItem = new DroppedItem(position, itemType, amount);
        const itemTexture = this.itemTextures.get(itemType) || null;
        const sprite = droppedItem.createSprite(this.textureAtlas, this.blockNames, itemTexture);
        this.scene.add(sprite);
        this.droppedItems.push(droppedItem);
        return droppedItem;
    }

    update(player, deltaTime) {
        // Update all dropped items
        for (let i = this.droppedItems.length - 1; i >= 0; i--) {
            const item = this.droppedItems[i];
            const shouldKeep = item.update(this.world, deltaTime);

            // Check for pickup
            if (item.canPickup(player.position)) {
                // Try to add to player inventory
                let remaining = item.amount;
                
                // Try to stack with existing items first
                for (let j = 0; j < player.inventory.length && remaining > 0; j++) {
                    const slot = player.inventory[j];
                    if (slot && typeof slot === 'object' && slot.type === item.itemType && slot.amount < 99) {
                        const space = 99 - slot.amount;
                        const toAdd = Math.min(space, remaining);
                        slot.amount += toAdd;
                        remaining -= toAdd;
                    }
                }

                // Then fill empty slots
                for (let j = 0; j < player.inventory.length && remaining > 0; j++) {
                    if (player.inventory[j] === 0) {
                        const toAdd = Math.min(99, remaining);
                        player.inventory[j] = { type: item.itemType, amount: toAdd };
                        remaining -= toAdd;
                    }
                }

                // Remove picked up items (or reduce amount if inventory was full)
                if (remaining === 0) {
                    this.removeDroppedItem(i);
                    // Return true to indicate an item was picked up
                    return true;
                } else {
                    item.amount = remaining;
                }
            } else if (!shouldKeep) {
                // Despawn old items
                this.removeDroppedItem(i);
            }
        }
        return false;
    }

    removeDroppedItem(index) {
        if (index >= 0 && index < this.droppedItems.length) {
            const item = this.droppedItems[index];
            if (item.sprite) {
                this.scene.remove(item.sprite);
                if (item.sprite.material && item.sprite.material.map) {
                    item.sprite.material.map.dispose();
                }
                if (item.sprite.material) {
                    item.sprite.material.dispose();
                }
            }
            this.droppedItems.splice(index, 1);
        }
    }

    clear() {
        for (let i = this.droppedItems.length - 1; i >= 0; i--) {
            this.removeDroppedItem(i);
        }
    }
}

class Game {
    constructor(worldType = 'default', isMultiplayer = false, team = 'red', playerName = 'Player', survivalMode = false, playerColor = null, playerEmail = null) {
        console.log('Game constructor started');
        
        this.playerName = playerName;
        this.playerEmail = playerEmail; // Store email
        this.survivalMode = survivalMode;
        this.customPlayerColor = playerColor; // Store custom color
        
        // Game music setup (plays randomly)
        this.gameMusic = new Audio('Posey.ogg');
        this.gameMusic.volume = 0.5;
        this.gameMusic.addEventListener('ended', () => {
            // Play again after a random delay (30-120 seconds)
            const delay = 30000 + Math.random() * 90000;
            setTimeout(() => {
                this.gameMusic.play().catch(e => console.log('Game music play failed:', e));
            }, delay);
        });
        // Start playing after a short delay
        setTimeout(() => {
            this.gameMusic.play().catch(e => console.log('Game music play failed:', e));
        }, 5000);
        
        // Block type to name mapping
        this.blockNames = {
            0: 'Air',
            1: 'Dirt',
            2: 'Grass',
            3: 'Stone',
            4: 'Sand',
            5: 'Water',
            6: 'Wood',
            7: 'Bricks',
            8: 'Ruby',
            9: 'Clay',
            10: 'Snow',
            11: 'Leafs',
            12: 'Sapphire',
            13: 'Plank',
            14: 'Paper',
            15: 'Stick',
            16: 'Scroll',
            17: 'Pork',
            18: 'Leather Helmet',
            19: 'Leather Chestplate',
            20: 'Leather Leggings',
            21: 'Leather Boots',
            22: 'Stone Sword',
            23: 'Wood Shield',
            24: 'Coal',
            25: 'Torch',
            26: 'Chest',
            27: 'Mana Orb',
            28: 'Fortitudo Scroll',
            29: 'Magic candle',
            30: 'Chisel',
            31: 'Cloud Pillow',
            32: 'Golden Sword',
            33: 'Grim Stone',
            34: 'Lava',
            35: 'Smiteth Scroll',
            36: 'Gloom'
        };
        
        // Lair system - hierarchical organization of items
        this.lairs = {
            'Stone': {
                name: 'Stone',
                description: 'Stone-based lairs and items',
                items: [],
                children: {
                    'Grim Stone': {
                        name: 'Grim Stone',
                        description: 'Grim Stone lair - dark and foreboding',
                        items: []
                    }
                }
            }
        };
        
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x87CEEB); // Sky blue
        const savedFogEnabled = localStorage.getItem('fogEnabled');
        const fogEnabled = savedFogEnabled === null ? true : savedFogEnabled !== 'false';
        const fogDensityRaw = parseFloat(localStorage.getItem('fogDensity'));
        const density = Number.isFinite(fogDensityRaw) ? Math.min(Math.max(fogDensityRaw, 0.0), 0.05) : 0.01; // clamp to sane range
        // Use exponential fog for a stronger, more obvious effect
        this.scene.fog = fogEnabled ? new THREE.FogExp2(0x87CEEB, density) : null;

        // Use saved FOV or default to 90
        const fov = parseFloat(localStorage.getItem('fov')) || 90;
        this.camera = new THREE.PerspectiveCamera(fov, window.innerWidth / window.innerHeight, 0.1, 1000);
        
        console.log('Creating renderer...');
        // Check if WebGL is supported
        if (!window.WebGLRenderingContext) {
            throw new Error('WebGL is not supported by your browser.');
        }
        // Validate canvas container dimensions
        const container = document.getElementById('canvas-container');
        if (container && (container.clientWidth === 0 || container.clientHeight === 0)) {
            console.warn('Canvas container has zero dimensions:', container.clientWidth, 'x', container.clientHeight);
        }
        console.log('Canvas container dimensions:', container ? (container.clientWidth + 'x' + container.clientHeight) : 'not found');
        console.log('Window dimensions:', window.innerWidth, 'x', window.innerHeight);
        
        this.renderer = new THREE.WebGLRenderer({ antialias: true, failIfMajorPerformanceCaveat: false });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.shadowMap.enabled = true;
        
        console.log('Container element:', container);
        
        if (!container) {
            console.error('canvas-container not found!');
            return;
        }
        // Attach renderer canvas to DOM so it's visible
        try {
            // Ensure canvas fills the container
            this.renderer.domElement.style.display = 'block';
            this.renderer.domElement.style.width = '100%';
            this.renderer.domElement.style.height = '100%';
            container.appendChild(this.renderer.domElement);
        } catch (e) {
            console.warn('Failed to append renderer DOM element:', e);
        }
        
        // Directional sun light
        this.sunLight = new THREE.DirectionalLight(0xFFFFFF, 1.0);
        this.sunLight.position.set(100, 100, 100);
        this.sunLight.castShadow = true;
        this.sunLight.shadow.camera.left = -200;
        this.sunLight.shadow.camera.right = 200;
        this.sunLight.shadow.camera.top = 200;
        this.sunLight.shadow.camera.bottom = -200;
        this.sunLight.shadow.mapSize.width = 2048;
        this.sunLight.shadow.mapSize.height = 2048;
        this.scene.add(this.sunLight);

        this.ambientLight = new THREE.AmbientLight(0xFFFFFF, 0.8);
        this.scene.add(this.ambientLight);
        // Astral dimension: boost ambient and sun light for a brighter look
        if (this.world && this.world.worldType === 'astral') {
            this.ambientLight.intensity = 1.2;
            this.sunLight.intensity = 1.1;
        }
        
        // Day/night cycle
        this.dayTime = 0.25; // Start at dawn (0=midnight, 0.25=sunrise, 0.5=noon, 0.75=sunset, 1.0=midnight)
        this.dayLength = 3600; // Full day cycle in seconds (60 minutes: 15 mins per quarter)
        this.freezeLighting = false; // Allow the sun to move (continuous cycle)

        console.log('Loading texture atlas...');
        this.textureAtlas = null;
        this.loadTextureAtlas();

        console.log('Creating world... (type:', worldType + ', multiplayer:', isMultiplayer, ', team:', team, ', survival:', survivalMode + ')');
        this.world = new VoxelWorld(worldType);
        this.isMultiplayer = !!isMultiplayer;
        this.team = team === 'blue' ? 'blue' : 'red';
        this.mesher = null; // Will be created after texture loads
        this.player = new Player(survivalMode);
        this.player.gameInstance = this; // Reference to game for curse effects
        // All players spawn at same location (0, 70, 0) when on server
        this.player.position.set(0, 70, 0);

        // Player model color: use custom color if provided, otherwise team color
        if (this.customPlayerColor) {
            this.playerColor = parseInt(this.customPlayerColor.replace('#', '0x'));
        } else {
            this.playerColor = this.team === 'blue' ? 0x3333ff : 0xff3333;
        }
        // Create a visible player model in the world
        this.createPlayerModel();

        // Hostile mobs
        this.pigmen = [];
        // Force-spawn pigmen nearby to guarantee they appear
        setTimeout(() => {
            console.log('[Init] Force-spawning pigmen after world ready...');
            console.log('[Init] Scene exists:', !!this.scene, 'Player pos:', this.player.position.x, this.player.position.y, this.player.position.z);
            
            if (!this.scene) {
                console.error('[Init] Scene not ready! Cannot spawn pigmen.');
                return;
            }
            
            for (let i = 0; i < 3; i++) {
                const angle = (Math.PI * 2 / 3) * i;
                const radius = 5 + Math.random() * 3;
                const px = this.player.position.x + Math.cos(angle) * radius;
                const py = this.player.position.y;
                const pz = this.player.position.z + Math.sin(angle) * radius;
                
                console.log(`[Init] Attempting spawn ${i + 1} at (${px.toFixed(1)}, ${py.toFixed(1)}, ${pz.toFixed(1)})`);
                const pig = this.spawnPigmanAtExact(px, py, pz);
                console.log(`[Init] Spawn ${i + 1} result:`, pig ? 'SUCCESS' : 'FAILED');
            }
            console.log(`[Init] Total pigmen after force-spawn: ${this.pigmen.length}`);
        }, 1500);
        this.pigmanPriest = null; // Boss mob
        this.minutors = [];
        this.spawnMinutors(2); // Spawn 2 Minutors in the maze
        
        // Mount
        this.phinox = null;
        this.isMountedOnPhinox = false;

        // If multiplayer, create a second player (local bot placeholder)
        if (this.isMultiplayer) {
            this.createOtherPlayer(this.team === 'blue' ? 'red' : 'blue');
        }
        // Third-person camera state
        this.thirdPerson = false;
        this.thirdPersonDistance = 4.0;
        this.thirdCamera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);

        // Hotbar selection index (0..7)
        this.hotbarIndex = 0;

        // Debug mode: when true, render simple Box meshes per visible block (slow)
        this.debugMode = true;

        this.chunkMeshes = new Map();
        this.chunkBounds = new Map(); // Map of chunk key -> bounding sphere for frustum culling
        this.chunkMeshQueue = []; // Queue of {cx,cz} to generate
        this.generatingChunkMesh = false; // Flag to process one per frame
        this.torchLights = new Map(); // Map of 'x,y,z' -> THREE.PointLight for torches
        this.lastTorchRebuildTime = 0; // Throttle torch rebuilds
        this.useRuntimeTorchLights = false; // Disable dynamic PointLight torches in favor of lightmaps
        this.chestStorage = new Map(); // Map of 'x,y,z' -> [20 slots] for chest inventory
        this.openChestPos = null; // Currently open chest position as 'x,y,z'
        this.candleStorage = new Map(); // Map of 'x,y,z' -> [3 slots] for magic candles
        this.opencandlePos = null; // Currently open candle position
        this.pendingBreak = null; // Track pending delayed block break
        this.crosshairProgress = 0; // Last rendered crosshair fill
        this.inAstralDimension = false; // Are we in the astral dimension?
        this.astralReturnState = null; // Saved overworld state when entering astral
        this.renderDistance = 3;
        this.blindnessEndTime = 0; // Timestamp when blindness effect ends

        this.clock = new THREE.Clock();
        this.lastFrameTime = 0;
        this.frameCount = 0;
        this.fps = 0;

        this.selectedBlock = null;
        this.selectedFace = null;

        console.log('Setting up input...');
        this.setupInput();
        
        // Initialize hotbar based on game mode
        this.initializeHotbar();
        
        console.log('Creating hand block...');
        this.handBlock = null;
        
        // Create HP bar if survival mode
        if (this.survivalMode) {
            this.createHealthBar();
        }

        // (music removed)

        // Request pointer lock immediately for easier control
        setTimeout(() => {
            try {
                const el = this.renderer && this.renderer.domElement;
                if (el && typeof el.requestPointerLock === 'function') {
                    el.requestPointerLock();
                }
            } catch (e) {
                console.warn('Auto pointer lock request failed', e);
            }
        }, 500);
        
        console.log('Starting animation loop...');
        this.animate();
    }

    // Connect to an online WebSocket server
    connectServer(host = 'localhost', port = 8080) {
        try {
            const url = `ws://${host}:${port}`;
            console.log('Connecting to server:', url);
            this.ws = new WebSocket(url);
            this.remotePlayers = new Map(); // {id -> {x,y,z,yaw,name,team}}
            this.remotePlayerModels = new Map(); // {id -> THREE.Group}

            this.ws.onopen = () => {
                console.log('Connected to server');
                // Send hello with player info
                try {
                    this.ws.send(JSON.stringify({ type: 'hello', name: this.playerName, team: this.team }));
                } catch {}
            };

            this.ws.onmessage = (evt) => {
                try {
                    const msg = JSON.parse(evt.data);
                    switch (msg.type) {
                        case 'welcome':
                            // Sync existing players
                            for (const p of msg.players || []) {
                                if (p.id !== msg.id) { // Don't render ourselves
                                    this.remotePlayers.set(p.id, p);
                                    this.createRemotePlayerModel(p);
                                }
                            }
                            break;
                        case 'join':
                            if (msg.player && !this.remotePlayers.has(msg.player.id)) {
                                this.remotePlayers.set(msg.player.id, msg.player);
                                this.createRemotePlayerModel(msg.player);
                            }
                            break;
                        case 'leave':
                            if (msg.id) {
                                this.remotePlayers.delete(msg.id);
                                this.removeRemotePlayerModel(msg.id);
                            }
                            break;
                        case 'state':
                            if (msg.id) {
                                const p = this.remotePlayers.get(msg.id) || { id: msg.id };
                                p.x = msg.x; p.y = msg.y; p.z = msg.z; p.yaw = msg.yaw;
                                this.remotePlayers.set(msg.id, p);
                            }
                            break;
                        case 'blockChange':
                            // Apply block changes from other players
                            if (msg.x !== undefined && msg.y !== undefined && msg.z !== undefined && msg.blockType !== undefined) {
                                this.world.setBlock(msg.x, msg.y, msg.z, msg.blockType);
                                const cx = Math.floor(msg.x / this.world.chunkSize);
                                const cz = Math.floor(msg.z / this.world.chunkSize);
                                this.updateChunkMesh(cx, cz);
                                // Update adjacent chunks if on edge
                                if (msg.x % this.world.chunkSize === 0) this.updateChunkMesh(cx - 1, cz);
                                if (msg.z % this.world.chunkSize === 0) this.updateChunkMesh(cx, cz - 1);
                            }
                            break;
                        default:
                            break;
                    }
                } catch (e) {
                    console.warn('Bad server message', e);
                }
            };

            this.ws.onclose = () => {
                console.log('Disconnected from server');
                // Clean up all remote player models
                for (const id of this.remotePlayerModels.keys()) {
                    this.removeRemotePlayerModel(id);
                }
            };
        } catch (e) {
            console.error('Failed to connect to server', e);
        }
    }

    createRemotePlayerModel(playerData) {
        if (!playerData || this.remotePlayerModels.has(playerData.id)) return;

        const group = new THREE.Group();
        // Use pigman texture if available, otherwise use team color
        const material = this.pigmanTexture ?
            new THREE.MeshLambertMaterial({ map: this.pigmanTexture }) :
            new THREE.MeshLambertMaterial({ color: playerData.team === 'blue' ? 0x3333ff : 0xff3333 });

        // Torso
        const torsoGeo = new THREE.BoxGeometry(0.6, 1.0, 0.4);
        const torso = new THREE.Mesh(torsoGeo, material);
        torso.castShadow = true;
        group.add(torso);

        // Head
        const headGeo = new THREE.BoxGeometry(0.45, 0.45, 0.45);
        const head = new THREE.Mesh(headGeo, material);
        head.position.y = 0.9;
        head.castShadow = true;
        group.add(head);

        // Legs
        const legsGeo = new THREE.BoxGeometry(0.6, 0.8, 0.35);
        const legs = new THREE.Mesh(legsGeo, material);
        legs.position.y = -0.9;
        legs.castShadow = true;
        group.add(legs);

        // Name label
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'Bold 40px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(playerData.name || 'Player', 128, 45);
        
        const nameTexture = new THREE.CanvasTexture(canvas);
        const nameMaterial = new THREE.MeshBasicMaterial({ map: nameTexture, transparent: true });
        const nameGeo = new THREE.PlaneGeometry(1.5, 0.4);
        const nameLabel = new THREE.Mesh(nameGeo, nameMaterial);
        nameLabel.position.y = 1.5;
        nameLabel.userData.isNameLabel = true;
        group.add(nameLabel);

        group.position.set(playerData.x || 0, playerData.y || 70, playerData.z || 0);
        group.rotation.y = playerData.yaw || 0;

        this.scene.add(group);
        this.remotePlayerModels.set(playerData.id, group);
    }

    removeRemotePlayerModel(id) {
        const model = this.remotePlayerModels.get(id);
        if (model) {
            this.scene.remove(model);
            this.remotePlayerModels.delete(id);
        }
    }

    loadTextureAtlas() {
        // Load individual block textures and composite them into an atlas
        const textureLoader = new THREE.TextureLoader();
        const blockTextures = new Map();
        
        // List of block textures to load (maps to atlas grid position)
        const textureMap = {
            'dirt': { x: 0, y: 0 },
            'grass': { x: 1, y: 0 },
            'stone': { x: 2, y: 0 },
            'sand': { x: 3, y: 0 },
            'water': { x: 0, y: 1 },
            'wood': { x: 1, y: 1 },
            'bricks': { x: 2, y: 1 },
            'ruby': { x: 3, y: 1 },
            'clay': { x: 0, y: 2 },
            'snow': { x: 1, y: 2 },
            'leafs': { x: 2, y: 2 },
            'sapphire': { x: 3, y: 2 },
            'coal': { x: 2, y: 0 },  // Use stone position as placeholder
            'torch': { x: 1, y: 3 }
        };
        
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');
        
        let loadedCount = 0;
        const totalTextures = Object.keys(textureMap).length;
        
        const finishLoading = () => {
            console.log(`Composited ${loadedCount}/${totalTextures} textures into atlas`);
            
            // Create atlas texture from canvas
            const atlasTexture = new THREE.CanvasTexture(canvas);
            atlasTexture.magFilter = THREE.NearestFilter;
            atlasTexture.minFilter = THREE.NearestFilter;
            atlasTexture.anisotropy = 1;
            this.textureAtlas = atlasTexture;
            
            // Load pigman texture separately for character skins
            textureLoader.load(
                'pigman.png',
                (texture) => {
                    texture.magFilter = THREE.NearestFilter;
                    texture.minFilter = THREE.NearestFilter;
                    this.pigmanTexture = texture;
                    console.log('Pigman texture loaded successfully');
                },
                undefined,
                (error) => {
                    console.warn('Failed to load pigman texture:', error);
                    // Create fallback colored canvas for pigman
                    const fallbackCanvas = document.createElement('canvas');
                    fallbackCanvas.width = 64;
                    fallbackCanvas.height = 64;
                    const fallbackCtx = fallbackCanvas.getContext('2d');
                    fallbackCtx.fillStyle = '#d28a7c'; // Pigman skin color
                    fallbackCtx.fillRect(0, 0, 64, 64);
                    this.pigmanTexture = new THREE.CanvasTexture(fallbackCanvas);
                    this.pigmanTexture.magFilter = THREE.NearestFilter;
                    this.pigmanTexture.minFilter = THREE.NearestFilter;
                }
            );
            
            // Load pigman 3D model
            if (typeof THREE.GLTFLoader !== 'undefined') {
                const gltfLoader = new THREE.GLTFLoader();
                gltfLoader.load(
                    'geo.gltf',
                    (gltf) => {
                        this.pigmanModelTemplate = gltf.scene;
                        console.log('✓ Pigman model (geo.gltf) loaded successfully');
                        console.log('  Model scene:', gltf.scene);
                        console.log('  Children:', gltf.scene.children.length);
                    },
                    (progress) => {
                        console.log('Model loading progress:', Math.round(progress.loaded / progress.total * 100) + '%');
                    },
                    (error) => {
                        console.error('✗ Failed to load pigman model (geo.gltf):', error);
                        this.pigmanModelTemplate = null; // Will fall back to box geometry
                    }
                );
            } else {
                console.warn('GLTFLoader not available - pigmen will use box geometry');
                this.pigmanModelTemplate = null;
            }
            
            // Create mesher with composite atlas
            this.mesher = new BlockMesher(this.world, this.textureAtlas);
            
            // Create item manager
            this.itemManager = new ItemManager(this.scene, this.world, this.textureAtlas, this.blockNames);
            
            // Create hand block after mesher is ready
            this.createHandBlock();
            
            // Generate initial chunks
            console.log('Generating initial chunks...');
            this.generateInitialChunks();
        };
        
        // Load each texture and composite into canvas
        Object.entries(textureMap).forEach(([filename, pos]) => {
            textureLoader.load(
                `${filename}.png`,
                (texture) => {
                    // Draw the loaded image to canvas at correct position
                    const canvas2d = document.createElement('canvas');
                    canvas2d.width = texture.image.width;
                    canvas2d.height = texture.image.height;
                    const ctx2d = canvas2d.getContext('2d');
                    ctx2d.drawImage(texture.image, 0, 0);
                    
                    // Scale and place in atlas grid (64x64 per tile in 256x256 = 4x4 grid)
                    const tileSize = 64;
                    const x = pos.x * tileSize;
                    const y = pos.y * tileSize;
                    ctx.drawImage(canvas2d, x, y, tileSize, tileSize);
                    
                    loadedCount++;
                    console.log(`Composited texture: ${filename}.png (${loadedCount}/${totalTextures})`);
                    
                    if (loadedCount === totalTextures) {
                        finishLoading();
                    }
                },
                undefined,
                (error) => {
                    console.warn(`Failed to load texture: ${filename}.png`, error);
                    // Create fallback colored square
                    const colors = {
                        'dirt': '#8B4513',
                        'grass': '#228B22',
                        'stone': '#808080',
                        'sand': '#F4D03F',
                        'water': '#0099FF',
                        'wood': '#CD853F',
                        'bricks': '#A0523D',
                        'ruby': '#E81828',
                        'clay': '#D4623D',
                        'snow': '#F0F8FF',
                        'leafs': '#228B22',
                        'sapphire': '#0047AB',
                        'coal': '#2c2c2c',
                        'torch': '#FFD700'
                    };
                    
                    const tileSize = 64;
                    const x = pos.x * tileSize;
                    const y = pos.y * tileSize;
                    ctx.fillStyle = colors[filename] || '#CCCCCC';
                    ctx.fillRect(x, y, tileSize, tileSize);
                    
                    loadedCount++;
                    if (loadedCount === totalTextures) {
                        finishLoading();
                    }
                }
            );
        });
    }

    createHandBlock() {
        if (!this.textureAtlas || !this.mesher) return;
        
        // Remove old hand block if exists
        if (this.handBlock) {
            this.scene.remove(this.handBlock);
        }
        
        // Create a small cube (0.3 units)
        const geometry = new THREE.BoxGeometry(0.3, 0.3, 0.3);
        const material = new THREE.MeshLambertMaterial({
            map: this.textureAtlas,
            side: THREE.DoubleSide
        });
        
        this.handBlock = new THREE.Mesh(geometry, material);
        this.handBlock.position.set(0.5, -0.5, -1.2); // Bottom right of view
        this.handBlock.rotation.set(0.5, 0.5, 0); // Slight rotation for 3D effect
        
        // Add to camera so it moves with view
        this.camera.add(this.handBlock);
    }

    updateHandBlock() {
        if (!this.handBlock) return;
        
        const blockType = this.player.selectedBlock;
        if (!blockType) return;
        
        // Get the appropriate UV coordinates for this block
        const uv = this.mesher.getBlockUVs(blockType);
        
        // Update all faces of the cube to use the correct UV
        const geometry = this.handBlock.geometry;
        const uvAttribute = geometry.getAttribute('uv');
        
        if (uvAttribute) {
            const uvArray = uvAttribute.array;
            const uvsPerFace = 4; // 4 vertices per face
            const numFaces = 6;
            
            for (let f = 0; f < numFaces; f++) {
                const baseIdx = f * uvsPerFace * 2;
                uvArray[baseIdx] = uv.minU;
                uvArray[baseIdx + 1] = uv.maxV;
                uvArray[baseIdx + 2] = uv.minU;
                uvArray[baseIdx + 3] = uv.minV;
                uvArray[baseIdx + 4] = uv.maxU;
                uvArray[baseIdx + 5] = uv.minV;
                uvArray[baseIdx + 6] = uv.maxU;
                uvArray[baseIdx + 7] = uv.maxV;
            }
            uvAttribute.needsUpdate = true;
        }
        
        // Rotate for visual effect
        this.handBlock.rotation.x += 0.01;
        this.handBlock.rotation.y += 0.02;
    }

    createPlayerModel() {
        // Simple low-poly player made from boxes
        const group = new THREE.Group();

        // Use pigman texture if available, otherwise use solid color
        let material;
        if (this.pigmanTexture) {
            material = new THREE.MeshLambertMaterial({ map: this.pigmanTexture });
        } else {
            material = new THREE.MeshLambertMaterial({ color: this.playerColor || 0x4477ff });
        }

        // Torso
        const torsoGeo = new THREE.BoxGeometry(0.6, 1.0, 0.4);
        const torso = new THREE.Mesh(torsoGeo, material);
        torso.position.y = 0.0;
        torso.castShadow = true;
        group.add(torso);

        // Head
        const headGeo = new THREE.BoxGeometry(0.45, 0.45, 0.45);
        const head = new THREE.Mesh(headGeo, material);
        head.position.y = 0.9;
        head.castShadow = true;
        group.add(head);

        // Legs (single block for simplicity)
        const legsGeo = new THREE.BoxGeometry(0.6, 0.8, 0.35);
        const legs = new THREE.Mesh(legsGeo, material);
        legs.position.y = -0.9;
        legs.castShadow = true;
        group.add(legs);

        // Add name label above player
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Check if email is the special email and use gold color for name
        if (this.playerEmail && this.playerEmail.toLowerCase() === 'christopherwamsley@gmail.com') {
            ctx.fillStyle = '#ffd700'; // Gold
            console.log('Gold name activated for email:', this.playerEmail);
        } else {
            ctx.fillStyle = '#ffffff'; // White
            console.log('Regular name for email:', this.playerEmail);
        }
        ctx.font = 'Bold 40px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(this.playerName, 128, 45);
        
        const nameTexture = new THREE.CanvasTexture(canvas);
        const nameMaterial = new THREE.MeshBasicMaterial({ map: nameTexture, transparent: true });
        const nameGeo = new THREE.PlaneGeometry(1.5, 0.4);
        const nameLabel = new THREE.Mesh(nameGeo, nameMaterial);
        nameLabel.position.y = 1.5;
        // Make label always face camera (updated in animate loop)
        nameLabel.userData.isNameLabel = true;
        group.add(nameLabel);

        // Place at player's starting position
        group.position.copy(this.player.position);
        group.rotation.y = this.player.yaw;

        this.scene.add(group);
        this.playerModel = group;

        // If player is named 'agare', add a cape to their model
        try {
            if (this.playerName && this.playerName.toLowerCase() === 'agare') {
                const capeWidth = 0.6;
                const capeHeight = 1.0;
                const capeGeo = new THREE.PlaneGeometry(capeWidth, capeHeight, 1, 8);
                // Pivot the plane at the top so it hangs down
                capeGeo.translate(0, -capeHeight / 2 + 0.12, 0);

                const capeMat = new THREE.MeshLambertMaterial({ color: 0x770011, side: THREE.DoubleSide });
                const cape = new THREE.Mesh(capeGeo, capeMat);
                // Position cape slightly behind the torso
                cape.position.set(0, 0.45, 0.28);
                // Make sure cape faces away from the back (flip if needed)
                cape.rotation.y = Math.PI; 
                cape.castShadow = true;
                cape.userData.isCape = true;

                // Store base positions for animation
                const posAttr = cape.geometry.getAttribute('position');
                cape.userData.basePositions = new Float32Array(posAttr.array.length);
                cape.userData.basePositions.set(posAttr.array);

                group.add(cape);
                this.playerCape = cape;
            }
        } catch (e) {
            console.warn('Failed to create cape:', e);
        }

        // If player is named 'iverstim', add floating music notes around their head
        try {
            if (this.playerName && this.playerName.toLowerCase() === 'iverstim') {
                const musicNotes = [];
                const noteCount = 5;
                const noteMaterial = new THREE.MeshLambertMaterial({ color: 0xaa44ff });
                
                for (let i = 0; i < noteCount; i++) {
                    // Create simple note shape from small boxes
                    const noteGroup = new THREE.Group();
                    
                    // Note head
                    const headGeo = new THREE.SphereGeometry(0.08, 8, 8);
                    const head = new THREE.Mesh(headGeo, noteMaterial);
                    noteGroup.add(head);
                    
                    // Note stem
                    const stemGeo = new THREE.BoxGeometry(0.03, 0.15, 0.03);
                    const stem = new THREE.Mesh(stemGeo, noteMaterial);
                    stem.position.set(0.08, 0.08, 0);
                    noteGroup.add(stem);
                    
                    // Position around head in a circle
                    const angle = (i / noteCount) * Math.PI * 2;
                    const radius = 0.5;
                    noteGroup.position.set(
                        Math.cos(angle) * radius,
                        1.5 + Math.sin(angle * 2) * 0.3,
                        Math.sin(angle) * radius
                    );
                    
                    // Store animation data
                    noteGroup.userData.isNote = true;
                    noteGroup.userData.basePos = {
                        x: noteGroup.position.x,
                        y: noteGroup.position.y,
                        z: noteGroup.position.z,
                        angle: angle
                    };
                    noteGroup.userData.time = Math.random() * Math.PI * 2;
                    
                    group.add(noteGroup);
                    musicNotes.push(noteGroup);
                }
                
                this.musicNotes = musicNotes;
            }
        } catch (e) {
            console.warn('Failed to create music notes:', e);
        }

        // If player is named 'cw', add floating hearts around their head
        try {
            if (this.playerName && this.playerName.toLowerCase() === 'cw') {
                const hearts = [];
                const heartCount = 6;
                const heartMaterial = new THREE.MeshLambertMaterial({ color: 0xff4488 });
                
                for (let i = 0; i < heartCount; i++) {
                    // Create simple heart shape from 2 spheres (lobes) and 1 cone (point)
                    const heartGroup = new THREE.Group();
                    
                    // Left lobe
                    const leftLobeGeo = new THREE.SphereGeometry(0.1, 8, 8);
                    const leftLobe = new THREE.Mesh(leftLobeGeo, heartMaterial);
                    leftLobe.position.set(-0.08, 0.05, 0);
                    heartGroup.add(leftLobe);
                    
                    // Right lobe
                    const rightLobeGeo = new THREE.SphereGeometry(0.1, 8, 8);
                    const rightLobe = new THREE.Mesh(rightLobeGeo, heartMaterial);
                    rightLobe.position.set(0.08, 0.05, 0);
                    heartGroup.add(rightLobe);
                    
                    // Bottom point (using cone)
                    const pointGeo = new THREE.ConeGeometry(0.12, 0.2, 8);
                    const point = new THREE.Mesh(pointGeo, heartMaterial);
                    point.position.set(0, -0.1, 0);
                    point.rotation.z = Math.PI;
                    heartGroup.add(point);
                    
                    // Position around head in a circle
                    const angle = (i / heartCount) * Math.PI * 2;
                    const radius = 0.6;
                    heartGroup.position.set(
                        Math.cos(angle) * radius,
                        1.5 + Math.sin(angle * 1.5) * 0.4,
                        Math.sin(angle) * radius
                    );
                    
                    // Store animation data
                    heartGroup.userData.isHeart = true;
                    heartGroup.userData.basePos = {
                        x: heartGroup.position.x,
                        y: heartGroup.position.y,
                        z: heartGroup.position.z,
                        angle: angle
                    };
                    heartGroup.userData.time = Math.random() * Math.PI * 2;
                    
                    group.add(heartGroup);
                    hearts.push(heartGroup);
                }
                
                this.hearts = hearts;
            }
        } catch (e) {
            console.warn('Failed to create hearts:', e);
        }
    }

    updatePlayerModel() {
        if (!this.playerModel || !this.player) return;
        // Keep model centered on player's world position
        this.playerModel.position.copy(this.player.position);
        // Align model yaw (rotate to face same direction as camera yaw)
        this.playerModel.rotation.y = this.player.yaw;
        
        // Update floating hearts
        if (this.hearts) {
            this.hearts.forEach(heart => {
                heart.userData.time += 0.05;
                const basePos = heart.userData.basePos;
                heart.position.x = basePos.x + Math.sin(heart.userData.time) * 0.12;
                heart.position.y = basePos.y + Math.cos(heart.userData.time * 0.7) * 0.2;
                heart.position.z = basePos.z + Math.sin(heart.userData.time * 1.1) * 0.12;
                heart.rotation.z += 0.06; // Rotate the hearts
                heart.rotation.x = Math.sin(heart.userData.time * 0.5) * 0.3;
            });
        }
        
        // Update floating music notes
        if (this.musicNotes) {
            this.musicNotes.forEach(note => {
                note.userData.time += 0.05;
                const basePos = note.userData.basePos;
                note.position.x = basePos.x + Math.sin(note.userData.time) * 0.1;
                note.position.y = basePos.y + Math.cos(note.userData.time * 0.8) * 0.15;
                note.position.z = basePos.z + Math.sin(note.userData.time * 1.2) * 0.1;
                note.rotation.z += 0.05; // Rotate the notes
            });
        }
        
        // Make name label face camera
        this.playerModel.children.forEach(child => {
            if (child.userData.isNameLabel) {
                child.lookAt(this.camera.position);
            }
        });
    }

    createOtherPlayer(team) {
        // Simple local bot placeholder for multiplayer
        const other = new Player();
        if (this.world && this.world.worldType === 'fortress') {
            const spawnY = 64 + 1.6;
            if (team === 'red') other.position.set(-10, spawnY, 8); else other.position.set(10, spawnY, -8);
        } else {
            if (team === 'red') other.position.set(-5, 70, 0); else other.position.set(5, 70, 0);
        }
        this.otherPlayer = other;

        // model
        const group = new THREE.Group();
        // Use pigman texture if available, otherwise use team color
        const material = this.pigmanTexture ?
            new THREE.MeshLambertMaterial({ map: this.pigmanTexture }) :
            new THREE.MeshLambertMaterial({ color: team === 'blue' ? 0x3333ff : 0xff3333 });
        const torsoGeo = new THREE.BoxGeometry(0.6, 1.0, 0.4);
        const torso = new THREE.Mesh(torsoGeo, material);
        torso.castShadow = true;
        group.add(torso);
        const headGeo = new THREE.BoxGeometry(0.45, 0.45, 0.45);
        const head = new THREE.Mesh(headGeo, material);
        head.position.y = 0.9;
        group.add(head);
        
        // Add name label for other player
        const otherTeam = team === 'red' ? 'blue' : 'red';
        const otherName = otherTeam === 'red' ? 'Red Player' : 'Blue Player';
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'Bold 40px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(otherName, 128, 45);
        
        const nameTexture = new THREE.CanvasTexture(canvas);
        const nameMaterial = new THREE.MeshBasicMaterial({ map: nameTexture, transparent: true });
        const nameGeo = new THREE.PlaneGeometry(1.5, 0.4);
        const nameLabel = new THREE.Mesh(nameGeo, nameMaterial);
        nameLabel.position.y = 1.5;
        nameLabel.userData.isNameLabel = true;
        group.add(nameLabel);
        
        group.position.copy(other.position);
        this.scene.add(group);
        this.otherPlayerModel = group;
    }

    spawnPigmanAt(x, z) {
        if (!this.world) return null;
        let surfaceY = this.world.getTerrainHeight(Math.floor(x), Math.floor(z));
        // If below water, clamp to water surface so spawn still succeeds
        if (surfaceY < this.world.waterLevel - 1) {
            surfaceY = this.world.waterLevel + 1;
        }

        const pos = new THREE.Vector3(x + 0.5, surfaceY + 1.1, z + 0.5);
        const pig = new Pigman(pos, this.survivalMode, this.pigmanTexture, this);
        const mesh = pig.createMesh();
        if (mesh) this.scene.add(mesh);
        this.pigmen.push(pig);
        console.log(`[Spawn] Pigman at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
        return pig;
    }

    // Spawn Pigman at exact coordinates (bypasses terrain height), useful for creative menu
    spawnPigmanAtExact(x, y, z) {
        console.log(`[spawnPigmanAtExact] Called with (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`);
        console.log(`[spawnPigmanAtExact] Scene exists:`, !!this.scene);
        
        if (!this.scene) {
            console.error('[spawnPigmanAtExact] No scene available!');
            return null;
        }
        
        try {
            const pos = new THREE.Vector3(x, y, z);
            console.log(`[spawnPigmanAtExact] Creating Pigman instance...`);
            const pig = new Pigman(pos, this.survivalMode, this.pigmanTexture, this);
            
            console.log(`[spawnPigmanAtExact] Creating mesh...`);
            const mesh = pig.createMesh();
            console.log(`[spawnPigmanAtExact] Mesh created:`, !!mesh);
            
            if (mesh) {
                this.scene.add(mesh);
                console.log(`[spawnPigmanAtExact] Mesh added to scene`);
            } else {
                console.error(`[spawnPigmanAtExact] Mesh creation returned null!`);
                return null;
            }
            
            this.pigmen.push(pig);
            console.log(`[Spawn] Pigman (exact) at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}) - Total: ${this.pigmen.length}`);
            return pig;
        } catch (error) {
            console.error('[spawnPigmanAtExact] Error during spawn:', error);
            return null;
        }
    }

    spawnPigmen(count = 3) {
        if (!this.world || !this.scene) return;
        const radius = Math.max(8, (this.renderDistance * this.world.chunkSize) - 4);
        for (let i = 0; i < count; i++) {
            let spawned = false;
            for (let attempt = 0; attempt < 20 && !spawned; attempt++) {
                // Bias spawns to be within current visible radius around player
                const angle = Math.random() * Math.PI * 2;
                const r = Math.random() * radius * 0.8;
                const rx = this.player.position.x + Math.cos(angle) * r;
                const rz = this.player.position.z + Math.sin(angle) * r;
                const pig = this.spawnPigmanAt(rx, rz);
                spawned = !!pig;
            }
            // Fallback: spawn near player if random attempts failed
            if (!spawned && this.player) {
                const forward = new THREE.Vector3(Math.sin(this.player.yaw), 0, Math.cos(this.player.yaw));
                const nearPos = this.player.position.clone().addScaledVector(forward, 3);
                const pig = this.spawnPigmanAtExact(nearPos.x, this.player.position.y, nearPos.z);
                spawned = !!pig;
            }
        }
        console.log(`[Spawn] Requested ${count} pigmen; now have ${this.pigmen.length}.`);
    }

    spawnAstralPigmen(count = 5) {
        if (!this.world || !this.scene) return;
        // Spawn pigmen around the cathedral exterior
        // Cathedral is at x: -15 to 15, z: -15 to 15
        for (let i = 0; i < count; i++) {
            let rx, rz, valid = false;
            // Spawn in a ring around the cathedral (distance 20-25 blocks away)
            while (!valid) {
                const angle = Math.random() * Math.PI * 2;
                const distance = 20 + Math.random() * 5;
                rx = Math.cos(angle) * distance;
                rz = Math.sin(angle) * distance;
                // Make sure they spawn on solid ground
                const surfaceY = this.world.getTerrainHeight(Math.floor(rx), Math.floor(rz));
                if (surfaceY > 50) { // Valid spawn height
                    valid = true;
                    const pos = new THREE.Vector3(rx + 0.5, surfaceY + 1.1, rz + 0.5);
                    const pig = new Pigman(pos, this.survivalMode, this.pigmanTexture, this);
                    const mesh = pig.createMesh();
                    if (mesh) this.scene.add(mesh);
                    this.pigmen.push(pig);
                }
            }
        }
        console.log(`Spawned ${count} pigmen around astral cathedral`);
    }

    spawnPigmanPriest() {
        if (!this.world || !this.scene) return;
        // Spawn priest on top of the podium (podium is at y: 74-76, center z: 11, x: -5 to 5)
        const pos = new THREE.Vector3(0, 77.5, 11);
        this.pigmanPriest = new PigmanPriest(pos, this.survivalMode);
        const mesh = this.pigmanPriest.createMesh();
        if (mesh) this.scene.add(mesh);
        console.log('Spawned Pigman Priest boss in astral cathedral!');
    }

    spawnPhinox() {
        if (this.phinox) {
            console.log('Phinox already exists!');
            return;
        }
        
        // Spawn directly at player position
        const spawnPos = this.player.position.clone();
        
        this.phinox = new Phinox(spawnPos);
        this.phinox.createMesh();
        if (this.phinox.mesh) {
            this.scene.add(this.phinox.mesh);
            console.log('Phinox summoned!');
            
            // Automatically mount the player
            this.mountPhinox();
        }
    }

    mountPhinox() {
        if (!this.phinox || this.isMountedOnPhinox) return;
        
        this.isMountedOnPhinox = true;
        this.phinox.mount(this.player);
        this.phinox.yaw = this.player.yaw;
        console.log('Mounted on Phinox!');
    }

    dismountPhinox() {
        if (!this.phinox || !this.isMountedOnPhinox) return;
        
        this.isMountedOnPhinox = false;
        this.phinox.dismount();
        
        // Place player slightly to the side
        this.player.position.copy(this.phinox.position);
        this.player.position.x += 2;
        console.log('Dismounted from Phinox');
    }

    recallPhinox() {
        if (!this.phinox) return;
        
        // Dismount if mounted
        if (this.isMountedOnPhinox) {
            this.dismountPhinox();
        }
        
        // Remove mesh from scene
        if (this.phinox.mesh && this.scene) {
            this.scene.remove(this.phinox.mesh);
        }
        
        // Clear the phinox reference
        this.phinox = null;
        this.isMountedOnPhinox = false;
        console.log('Phinox recalled to inventory!');
    }

    updatePigmen(deltaTime) {
        if (!this.pigmen || this.pigmen.length === 0) return;
        // Throttle: update every 3rd frame for performance
        if (!this._pigmenUpdateCounter) this._pigmenUpdateCounter = 0;
        this._pigmenUpdateCounter++;
        if (this._pigmenUpdateCounter % 3 !== 0) return;
        
        const startTime = performance.now();
        for (const pig of this.pigmen) {
            pig.update(this.world, this.player, deltaTime * 3); // Compensate for skipped frames
        }
        const elapsed = performance.now() - startTime;
        if (elapsed > 50) {
            console.warn(`[PERF] updatePigmen took ${elapsed.toFixed(2)}ms (${this.pigmen.length} pigmen)`);
        }
    }

    spawnMinutorAt(x, y, z) {
        if (!this.world) return null;
        
        const pos = new THREE.Vector3(x + 0.5, y + 1.0, z + 0.5);
        const minutor = new Minutor(pos, this.survivalMode);
        const mesh = minutor.createMesh();
        if (mesh) this.scene.add(mesh);
        this.minutors.push(minutor);
        return minutor;
    }

    spawnMinutors(count = 2) {
        if (!this.world || !this.scene) return;
        
        // Maze bounds: x,z in [-16,15], floor y=19, corridors at y=20..22
        const mazeMinX = -16;
        const mazeMaxX = 15;
        const mazeMinZ = -16;
        const mazeMaxZ = 15;
        const mazeFloorY = 19;
        
        for (let i = 0; i < count; i++) {
            let spawned = false;
            for (let attempt = 0; attempt < 20 && !spawned; attempt++) {
                // Random position in maze
                const rx = Math.floor(Math.random() * (mazeMaxX - mazeMinX + 1)) + mazeMinX;
                const rz = Math.floor(Math.random() * (mazeMaxZ - mazeMinZ + 1)) + mazeMinZ;
                const ry = mazeFloorY + 1; // Spawn on corridor floor
                
                // Check if spawn position is air (corridor)
                const block = this.world.getBlock(rx, ry, rz);
                if (block === 0) { // Air space in corridor
                    const minutor = this.spawnMinutorAt(rx, ry, rz);
                    spawned = !!minutor;
                }
            }
        }
        console.log(`Spawned ${this.minutors.length} Minutors in the maze`);
    }

    updateMinutors(deltaTime) {
        if (!this.minutors || this.minutors.length === 0) return;
        // Throttle: update every 3rd frame for performance
        if (!this._minutorUpdateCounter) this._minutorUpdateCounter = 0;
        this._minutorUpdateCounter++;
        if (this._minutorUpdateCounter % 3 !== 0) return;
        
        const startTime = performance.now();
        for (const minutor of this.minutors) {
            minutor.update(this.world, this.player, deltaTime * 3); // Compensate for skipped frames
        }
        const elapsed = performance.now() - startTime;
        if (elapsed > 50) {
            console.warn(`[PERF] updateMinutors took ${elapsed.toFixed(2)}ms (${this.minutors.length} minutors)`);
        }
    }

    setupInput() {
        // Keyboard
        document.addEventListener('keydown', (e) => {
            // Toggle fairia dimension with F7
            if (e.key === 'F7') {
                e.preventDefault();
                // Save current position
                const pos = this.player.position.clone();
                // Clear existing chunk meshes first
                this.clearChunkMeshes();
                this.clearTorchLights();
                // Toggle world type
                if (this.world.worldType !== 'fairia') {
                    this.world = new VoxelWorld('fairia');
                    this.mesher = new BlockMesher(this.world, this.textureAtlas);
                    if (this.itemManager) this.itemManager.world = this.world;
                    this.player.position.copy(pos);
                    this.player.velocity.set(0, 0, 0);
                    this.scene.background = new THREE.Color(0x000000); // black sky
                    this.scene.fog = new THREE.FogExp2(0xFF0000, 0.02); // red fog
                    this.ambientLight.intensity = 0.7;
                    this.sunLight.intensity = 0.7;
                    // Switch to Hell's Kingdom music
                    this.gameMusic.pause();
                    this.gameMusic.currentTime = 0;
                    this.gameMusic.src = 'Hells Kingdom.ogg';
                    setTimeout(() => {
                        this.gameMusic.play().catch(e => console.log('Fairia music play failed:', e));
                    }, 100);
                    console.log('Switched to fairia dimension');
                } else {
                    this.world = new VoxelWorld('default');
                    this.mesher = new BlockMesher(this.world, this.textureAtlas);
                    if (this.itemManager) this.itemManager.world = this.world;
                    this.player.position.copy(pos);
                    this.player.velocity.set(0, 0, 0);
                    this.scene.background = new THREE.Color(0x87CEEB); // sky blue
                    // Restore default fog settings
                    const savedFogEnabled = localStorage.getItem('fogEnabled');
                    const fogEnabled = savedFogEnabled === null ? true : savedFogEnabled !== 'false';
                    const fogDensityRaw = parseFloat(localStorage.getItem('fogDensity'));
                    const density = Number.isFinite(fogDensityRaw) ? Math.min(Math.max(fogDensityRaw, 0.0), 0.05) : 0.01;
                    this.scene.fog = fogEnabled ? new THREE.FogExp2(0x87CEEB, density) : null;
                    this.ambientLight.intensity = 0.8;
                    this.sunLight.intensity = 1.0;
                    // Switch back to Posey music
                    this.gameMusic.pause();
                    this.gameMusic.currentTime = 0;
                    this.gameMusic.src = 'Posey.ogg';
                    setTimeout(() => {
                        this.gameMusic.play().catch(e => console.log('Default music play failed:', e));
                    }, 100);
                    console.log('Returned to default dimension');
                }
                // Force chunk reload
                this.chunkMeshes = new Map();
                this.chunkBounds = new Map();
                this.chunkMeshQueue = [];
                this.generateInitialChunks();
                return;
            }
            // Toggle day/night instantly
            if (e.key === 'F1') {
                e.preventDefault();
                // Flip between morning (0.25) and midnight (0.75)
                this.dayTime = (this.dayTime < 0.5) ? 0.75 : 0.25;
                return;
            }

            // Toggle third/first person
            if (e.key === 'F5') {
                e.preventDefault();
                this.thirdPerson = !this.thirdPerson;
                console.log('Third-person:', this.thirdPerson);
                // when switching modes, ensure visibility updates immediately
                if (this.thirdPerson && this.handBlock && this.handBlock.parent) {
                    try { this.handBlock.parent.remove(this.handBlock); } catch (err) {}
                }
                this.playerModel.visible = !!this.thirdPerson;
                return;
            }

            // Detect double-tap W for sprint
            if ((e.key === 'w' || e.key === 'W') && !this.player.isSprinting) {
                const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
                const timeSinceLastW = now - this.player.lastWPressTime;

                if (timeSinceLastW < this.player.wDoubleTapWindow) {
                    // Double-tap detected!
                    this.player.isSprinting = true;
                    this.player.sprintEndTime = now + this.player.sprintDuration;
                    console.log('Sprint activated!');
                }
                this.player.lastWPressTime = now;
            }

            // Toggle fly mode
            if (e.key === 'F6') {
                e.preventDefault();
                this.player.flyMode = !this.player.flyMode;
                this.player.velocity.y = 0; // Reset vertical velocity when toggling
                console.log('Fly mode:', this.player.flyMode);
                return;
            }

            this.player.keys[e.key.toLowerCase()] = true;
            
            // Toggle inventory with E
            if (e.key.toLowerCase() === 'e') {
                e.preventDefault();
                this.toggleInventory();
                return;
            }

            // Toggle pause menu with Tab
            if (e.key === 'Tab') {
                e.preventDefault();
                this.togglePauseMenu();
                return;
            }

            // Toggle creative menu with C (only in non-survival mode)
            if (e.key.toLowerCase() === 'c' && !this.survivalMode) {
                e.preventDefault();
                this.toggleCreativeMenu();
                return;
            }

            // Toggle mob spawn menu with V (only in non-survival mode)
            if (e.key.toLowerCase() === 'v' && !this.survivalMode) {
                e.preventDefault();
                this.toggleSpawnMenu();
                return;
            }

            if (e.key === ' ') {
                e.preventDefault();
                this.player.jump(this.world);

                // If player was holding forward and directly blocked, disable forward for 2s
                try {
                    const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
                    if ((this.player.keys['w'] || this.player.keys['arrowup']) && this.player.isForwardBlocked(this.world)) {
                        this.player.wDisabledUntil = now + 2000; // 2 seconds
                        // force immediate stop of forward input
                        this.player.keys['w'] = false;
                        this.player.keys['arrowup'] = false;
                    }
                } catch (e) {
                    // ignore
                }
            }

            // Arrow keys for camera look (alternative to mouse) — disabled in fly mode so arrows can be movement
            if (!this.player.flyMode) {
                const lookSpeed = 0.05;
                if (e.key === 'ArrowUp') this.player.pitch -= lookSpeed;
                if (e.key === 'ArrowDown') this.player.pitch += lookSpeed;
                if (e.key === 'ArrowLeft') this.player.yaw -= lookSpeed;
                if (e.key === 'ArrowRight') this.player.yaw += lookSpeed;
                this.player.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.player.pitch));
            }

            // Block selection by number keys (map to hotbar slots)
            const num = parseInt(e.key);
            if (!isNaN(num)) {
                const slots = document.querySelectorAll('.hotbar-slot');
                if (num >= 1 && num <= slots.length) {
                    const slot = slots[num - 1];
                    const bt = parseInt(slot.dataset.block) || 0;
                    this.player.selectedBlock = bt;
                    this.hotbarIndex = num - 1;
                    this.updateHotbar();
                }
            }
        });

        document.addEventListener('keyup', (e) => {
            this.player.keys[e.key.toLowerCase()] = false;
        });

        // Mouse
        document.addEventListener('mousemove', (e) => {
            if (document.pointerLockElement === this.renderer.domElement) {
                this.player.yaw -= e.movementX * 0.002;
                this.player.pitch -= e.movementY * 0.002;
                this.player.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.player.pitch));
            }
        });

        document.addEventListener('click', (e) => {
            // Don't request pointer lock if clicking on inventory UI
            if (this._inventoryEl && this._inventoryEl.contains(e.target)) {
                return;
            }
            
            try {
                const el = this.renderer && this.renderer.domElement;
                if (!el || !document.body.contains(el)) return;
                if (typeof el.requestPointerLock === 'function') {
                    el.requestPointerLock();
                }
            } catch (e) {
                console.warn('requestPointerLock failed or target removed from DOM', e);
            }
        });

        // Mouse buttons
        document.addEventListener('mousedown', (e) => {
            if (e.button === 0) {
                // Don't destroy block if chest or candle UI is open
                if (this.openChestPos || this.opencandlePos) return;
                
                // In survival mode, try to attack pigman first
                if (this.survivalMode) {
                    const attacked = this.attackPigman();
                    if (!attacked) this.destroyBlock(); // If no pigman hit, destroy block
                } else {
                    this.destroyBlock(); // Normal mode: just destroy block
                }
            }
            if (e.button === 2) {
                // Use Cloud Pillow in off-hand to toggle astral dimension during night
                if (this.hasCloudPillowEquipped()) {
                    // Avoid activating while UI is open
                    if (this.inventoryOpen || this.openChestPos || this.opencandlePos) return;

                    if (this.inAstralDimension) {
                        this.exitAstralDimension();
                        return;
                    }
                    if (this.isNightTime()) {
                        this.enterAstralDimension();
                        return;
                    }
                }

                // Check if holding pork to eat it (survival mode only)
                if (this.survivalMode) {
                    const hotbarSlot = this.hotbarIndex;
                    const item = this.player.inventory[hotbarSlot];
                    
                    if ((item && typeof item === 'object' && item.type === 17) || item === 17) {
                        // Eating pork!
                        if (this.player.health < this.player.maxHealth) {
                            // Consume 1 pork and heal 2 HP
                            if (typeof item === 'object') {
                                item.amount--;
                                if (item.amount <= 0) {
                                    this.player.inventory[hotbarSlot] = 0;
                                }
                            } else {
                                // Legacy numeric format: consume single pork
                                this.player.inventory[hotbarSlot] = 0;
                            }
                            this.player.health = Math.min(this.player.maxHealth, this.player.health + 2);
                            console.log(`Ate pork! Restored 2 HP. Health: ${this.player.health}/${this.player.maxHealth}`);
                            this.updateInventoryUI();
                            this.updateHealthBar();
                            return; // Don't place block
                        } else {
                            console.log('Health is already full!');
                            return;
                        }
                    }
                }
                
                this.placeBlock();   // Right click - place block
            }
        });

        // Require holding left mouse to break: cancel on mouseup
        document.addEventListener('mouseup', (e) => {
            if (e.button === 0) {
                if (this.pendingBreak && this.pendingBreak.timeout) {
                    try { clearTimeout(this.pendingBreak.timeout); } catch (err) {}
                    this.pendingBreak = null;
                    this.setCrosshairProgress(0);
                }
            }
        });

        document.addEventListener('contextmenu', (e) => e.preventDefault());

        // Hotbar clicks
        const hotbarSlots = document.querySelectorAll('.hotbar-slot');
        hotbarSlots.forEach((slot, idx) => {
            slot.addEventListener('click', () => {
                const blockType = parseInt(slot.dataset.block) || 0;
                if (blockType > 0) {
                    this.player.selectedBlock = blockType;
                    this.hotbarIndex = idx;
                    this.updateHotbar();
                }
            });
            // accept drops from inventory
            slot.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
            });
            slot.addEventListener('drop', (e) => {
                e.preventDefault();
                let srcIdx = null;
                try { srcIdx = Number(e.dataTransfer.getData('text/plain')); } catch (err) { srcIdx = null; }
                if (isNaN(srcIdx) || srcIdx === null) return;

                // swap inventory[srcIdx] with hotbar slot's item
                const invVal = this.player.inventory[srcIdx] || 0;
                const hotVal = parseInt(slot.dataset.block) || 0;

                // perform swap - handle both stacked objects and old numeric format
                this.player.inventory[srcIdx] = hotVal;
                const blockTypeToStore = typeof invVal === 'object' ? invVal.type : invVal;
                slot.dataset.block = blockTypeToStore;

                // update hotbar display - set text directly on slot
                const blockName = this.blockNames[blockTypeToStore] || '';
                slot.textContent = blockName;

                this.updateInventoryUI();
                this.updateHotbar(); // Refresh hotbar to ensure proper display
                
                if (blockTypeToStore > 0) {
                    this.player.selectedBlock = blockTypeToStore;
                    this.hotbarIndex = idx;
                }
            });
        });

        // Mouse wheel to select hotbar
        document.addEventListener('wheel', (e) => {
            if (this.inventoryOpen) return; // don't change while inventory open
            const slots = document.querySelectorAll('.hotbar-slot');
            if (!slots || slots.length === 0) return;
            e.preventDefault();
            if (e.deltaY > 0) {
                this.hotbarIndex = (this.hotbarIndex + 1) % slots.length;
            } else if (e.deltaY < 0) {
                this.hotbarIndex = (this.hotbarIndex - 1 + slots.length) % slots.length;
            }
            const slot = slots[this.hotbarIndex];
            const bt = parseInt(slot.dataset.block) || 0;
            this.player.selectedBlock = bt;
            this.updateHotbar();
        }, { passive: false });

        // Window resize
        window.addEventListener('resize', () => this.onWindowResize());

        // Gamepad support
        this.gamepadState = {
            connected: false,
            leftStickX: 0,
            leftStickY: 0,
            rightStickX: 0,
            rightStickY: 0,
            buttonsPressed: {},
            inventorySelectedIndex: 0,
            lastStickMoveTime: 0
        };
        window.addEventListener('gamepadconnected', (e) => {
            console.log('Gamepad connected:', e.gamepad.id);
            this.gamepadState.connected = true;
        });
        window.addEventListener('gamepaddisconnected', (e) => {
            console.log('Gamepad disconnected');
            this.gamepadState.connected = false;
        });
    }

    updateGamepadInput() {
        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        if (!gamepads || gamepads.length === 0) return;
        
        const gamepad = gamepads[0]; // Use first connected gamepad
        if (!gamepad) return;

        const deadzone = 0.15;
        
        // Left stick for movement (W/A/S/D) or inventory navigation
        const lx = Math.abs(gamepad.axes[0]) > deadzone ? gamepad.axes[0] : 0;
        const ly = Math.abs(gamepad.axes[1]) > deadzone ? gamepad.axes[1] : 0;
        
        // Right stick for camera look
        const rx = Math.abs(gamepad.axes[2]) > deadzone ? gamepad.axes[2] : 0;
        const ry = Math.abs(gamepad.axes[3]) > deadzone ? gamepad.axes[3] : 0;
        
        // Check if any menu is open (only treat creative menu as open when visible)
        const creativeOpen = this._creativeMenuEl && this._creativeMenuEl.style && this._creativeMenuEl.style.display === 'block';
        const menuOpen = !!(this.inventoryOpen || this.openChestPos || this.opencandlePos || creativeOpen);
        
        if (menuOpen) {
            // Left stick for inventory navigation with rate limiting
            const now = performance.now();
            const moveDelay = 300; // milliseconds between moves (increased from 200 for better performance)
            
            if (now - this.gamepadState.lastStickMoveTime > moveDelay) {
                // Determine which UI grid is active and query appropriate slots
                let slots = [];
                let cols = 10; // default inventory columns
                let currentMenuType = null;
                
                if (this.inventoryOpen && this._inventoryEl) {
                    slots = Array.from(this._inventoryEl.querySelectorAll('.inv-slot'));
                    cols = 10;
                    currentMenuType = 'inventory';
                } else if (this.openChestPos && this._inventoryEl) {
                    // Chest UI uses .chest-slot in a 5x4 grid
                    slots = Array.from(this._inventoryEl.querySelectorAll('.chest-slot'));
                    cols = 5;
                    currentMenuType = 'chest';
                } else if (this.opencandlePos && this._inventoryEl) {
                    // candle UI also reuses .chest-slot in a 3-column grid
                    slots = Array.from(this._inventoryEl.querySelectorAll('.chest-slot'));
                    cols = 3;
                    currentMenuType = 'candle';
                } else if (creativeOpen && this._creativeMenuEl) {
                    // Creative menu: navigate its buttons grid (6 columns)
                    slots = Array.from(this._creativeMenuEl.querySelectorAll('button'));
                    cols = 6;
                    currentMenuType = 'creative';
                }

                // Only process if menu type changed or slots changed length
                if (slots && slots.length > 0 && (this.gamepadState.lastMenuType !== currentMenuType || this.gamepadState.lastSlotsLength !== slots.length)) {
                    this.gamepadState.lastMenuType = currentMenuType;
                    this.gamepadState.lastSlotsLength = slots.length;
                    this.gamepadState.inventorySelectedIndex = 0; // Reset to first slot on menu change
                }

                if (slots && slots.length > 0) {
                    // Clamp selected index to bounds
                    this.gamepadState.inventorySelectedIndex = Math.min(Math.max(this.gamepadState.inventorySelectedIndex, 0), slots.length - 1);

                    let moved = false;
                    const currentRow = Math.floor(this.gamepadState.inventorySelectedIndex / cols);
                    const currentCol = this.gamepadState.inventorySelectedIndex % cols;

                    if (ly < -0.5) { // Up
                        if (currentRow > 0) {
                            this.gamepadState.inventorySelectedIndex = Math.max(0, this.gamepadState.inventorySelectedIndex - cols);
                            moved = true;
                        }
                    } else if (ly > 0.5) { // Down
                        const maxRow = Math.floor((slots.length - 1) / cols);
                        if (currentRow < maxRow) {
                            this.gamepadState.inventorySelectedIndex = Math.min(slots.length - 1, this.gamepadState.inventorySelectedIndex + cols);
                            moved = true;
                        }
                    }

                    if (lx < -0.5) { // Left
                        if (currentCol > 0) {
                            this.gamepadState.inventorySelectedIndex--;
                            moved = true;
                        }
                    } else if (lx > 0.5) { // Right
                        if (currentCol < cols - 1 && this.gamepadState.inventorySelectedIndex < slots.length - 1) {
                            this.gamepadState.inventorySelectedIndex++;
                            moved = true;
                        }
                    }

                    if (moved) {
                        this.gamepadState.lastStickMoveTime = now;
                        // Update visual selection highlight - only update changed slots for performance
                        const prevIdx = this.gamepadState.lastInventorySelectedIndex;
                        if (prevIdx !== undefined && prevIdx !== this.gamepadState.inventorySelectedIndex) {
                            if (prevIdx < slots.length) {
                                slots[prevIdx].style.outline = '';
                            }
                        }
                        slots[this.gamepadState.inventorySelectedIndex].style.outline = '3px solid yellow';
                        this.gamepadState.lastInventorySelectedIndex = this.gamepadState.inventorySelectedIndex;
                        
                        // Also scroll into view if inside a scrollable container
                        const selectedEl = slots[this.gamepadState.inventorySelectedIndex];
                        try { if (selectedEl && typeof selectedEl.scrollIntoView === 'function') selectedEl.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
                    }
                }
            }
        } else {
            // Normal movement when no menu is open
            // Update movement keys based on left stick
            this.player.keys['w'] = ly < -0.3;  // Left stick up = move forward
            this.player.keys['s'] = ly > 0.3;   // Left stick down = move backward
            this.player.keys['a'] = lx < -0.3; // Left stick left = strafe left
            this.player.keys['d'] = lx > 0.3;  // Left stick right = strafe right
            
            // Right stick for camera (similar to mouse look)
            const lookSpeed = 0.08;
            if (Math.abs(rx) > deadzone) {
                this.player.yaw -= rx * lookSpeed;
            }
            if (Math.abs(ry) > deadzone) {
                this.player.pitch -= ry * lookSpeed;
                this.player.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.player.pitch));
            }
        }
        
        // Buttons mapping
        // A button (index 0) = Select/Click item in inventory, or Jump when no menu open
        if (gamepad.buttons[0] && gamepad.buttons[0].pressed && !this.gamepadState.buttonsPressed[0]) {
            if (menuOpen) {
                // Menu is open: click the selected inventory slot
                let slots = [];
                if (this.inventoryOpen && this._inventoryEl) {
                    slots = Array.from(this._inventoryEl.querySelectorAll('.inv-slot'));
                } else if (this.openChestPos && this._inventoryEl) {
                    slots = Array.from(this._inventoryEl.querySelectorAll('.chest-slot'));
                } else if (this.opencandlePos && this._inventoryEl) {
                    slots = Array.from(this._inventoryEl.querySelectorAll('.chest-slot'));
                } else if (creativeOpen && this._creativeMenuEl) {
                    slots = Array.from(this._creativeMenuEl.querySelectorAll('button'));
                }
                
                if (slots && slots.length > 0) {
                    const selectedIdx = Math.min(Math.max(this.gamepadState.inventorySelectedIndex, 0), slots.length - 1);
                    const slot = slots[selectedIdx];
                    if (slot) {
                        slot.click();
                    }
                }
            } else {
                // No menu: jump
                this.player.jump(this.world);
            }
            this.gamepadState.buttonsPressed[0] = true;
        } else if (!gamepad.buttons[0] || !gamepad.buttons[0].pressed) {
            this.gamepadState.buttonsPressed[0] = false;
        }
        
        // B button (index 1) = Sprint/Alternative
        if (gamepad.buttons[1] && gamepad.buttons[1].pressed && !this.gamepadState.buttonsPressed[1]) {
            this.gamepadState.buttonsPressed[1] = true;
        } else if (!gamepad.buttons[1] || !gamepad.buttons[1].pressed) {
            this.gamepadState.buttonsPressed[1] = false;
        }
        
        // X button (index 2) = Toggle creative menu (only in non-survival mode)
        if (gamepad.buttons[2] && gamepad.buttons[2].pressed && !this.gamepadState.buttonsPressed[2]) {
            if (!this.survivalMode) {
                this.toggleCreativeMenu();
            }
            this.gamepadState.buttonsPressed[2] = true;
        } else if (!gamepad.buttons[2] || !gamepad.buttons[2].pressed) {
            this.gamepadState.buttonsPressed[2] = false;
        }
        
        // LT (Left Trigger, index 6) = Place block
        if (gamepad.buttons[6] && gamepad.buttons[6].pressed && !this.gamepadState.buttonsPressed[6]) {
            this.placeBlock();
            this.gamepadState.buttonsPressed[6] = true;
        } else if (!gamepad.buttons[6] || !gamepad.buttons[6].pressed) {
            this.gamepadState.buttonsPressed[6] = false;
        }
        
        // RT (Right Trigger, index 7) = Destroy block
        if (gamepad.buttons[7] && gamepad.buttons[7].pressed && !this.gamepadState.buttonsPressed[7]) {
            if (!this.openChestPos && !this.opencandlePos) {
                if (this.survivalMode) {
                    const attacked = this.attackPigman();
                    if (!attacked) this.destroyBlock();
                } else {
                    this.destroyBlock();
                }
            }
            this.gamepadState.buttonsPressed[7] = true;
        } else if (!gamepad.buttons[7] || !gamepad.buttons[7].pressed) {
            this.gamepadState.buttonsPressed[7] = false;
        }
        
        // Y button (index 3) = Toggle inventory
        if (gamepad.buttons[3] && gamepad.buttons[3].pressed && !this.gamepadState.buttonsPressed[3]) {
            this.toggleInventory();
            this.gamepadState.buttonsPressed[3] = true;
        } else if (!gamepad.buttons[3] || !gamepad.buttons[3].pressed) {
            this.gamepadState.buttonsPressed[3] = false;
        }
        
        // LB (index 4) = Cycle hotbar left
        if (gamepad.buttons[4] && gamepad.buttons[4].pressed && !this.gamepadState.buttonsPressed[4]) {
            const slots = document.querySelectorAll('.hotbar-slot');
            if (slots.length > 0) {
                this.hotbarIndex = (this.hotbarIndex - 1 + slots.length) % slots.length;
                const slot = slots[this.hotbarIndex];
                const bt = parseInt(slot.dataset.block) || 0;
                this.player.selectedBlock = bt;
                this.updateHotbar();
            }
            this.gamepadState.buttonsPressed[4] = true;
        } else if (!gamepad.buttons[4] || !gamepad.buttons[4].pressed) {
            this.gamepadState.buttonsPressed[4] = false;
        }
        
        // RB (index 5) = Cycle hotbar right
        if (gamepad.buttons[5] && gamepad.buttons[5].pressed && !this.gamepadState.buttonsPressed[5]) {
            const slots = document.querySelectorAll('.hotbar-slot');
            if (slots.length > 0) {
                this.hotbarIndex = (this.hotbarIndex + 1) % slots.length;
                const slot = slots[this.hotbarIndex];
                const bt = parseInt(slot.dataset.block) || 0;
                this.player.selectedBlock = bt;
                this.updateHotbar();
            }
            this.gamepadState.buttonsPressed[5] = true;
        } else if (!gamepad.buttons[5] || !gamepad.buttons[5].pressed) {
            this.gamepadState.buttonsPressed[5] = false;
        }
        
        // Menu button (index 9, usually Start) = Pause menu
        if (gamepad.buttons[9] && gamepad.buttons[9].pressed && !this.gamepadState.buttonsPressed[9]) {
            this.togglePauseMenu();
            this.gamepadState.buttonsPressed[9] = true;
        } else if (!gamepad.buttons[9] || !gamepad.buttons[9].pressed) {
            this.gamepadState.buttonsPressed[9] = false;
        }
    }

    updateHotbar() {
        const slots = document.querySelectorAll('.hotbar-slot');
        if (!slots || slots.length === 0) return;

        // Try to align hotbarIndex with selectedBlock if possible
        let foundIndex = -1;
        slots.forEach((slot, i) => {
            const bt = parseInt(slot.dataset.block) || 0;
            if (bt === this.player.selectedBlock && foundIndex === -1) foundIndex = i;
        });
        if (foundIndex !== -1) this.hotbarIndex = foundIndex;

        slots.forEach((slot, i) => {
            if (i === this.hotbarIndex) slot.classList.add('selected'); else slot.classList.remove('selected');
        });
    }

    initializeHotbar() {
        const slots = document.querySelectorAll('.hotbar-slot');
        if (!slots || slots.length === 0) return;

        if (this.survivalMode) {
            // In survival mode: start with empty hotbar
            slots.forEach((slot) => {
                slot.dataset.block = '0';
                slot.textContent = '';
            });
            // Select first slot but with no block
            this.hotbarIndex = 0;
            this.player.selectedBlock = 0;
        } else {
            // In creative mode: populate hotbar with common blocks
            const blockTypes = [1, 2, 3, 4, 5, 6, 7, 8, 12];
            slots.forEach((slot, i) => {
                if (i < blockTypes.length) {
                    const blockType = blockTypes[i];
                    slot.dataset.block = blockType;
                    slot.textContent = this.blockNames[blockType] || '';
                } else {
                    slot.dataset.block = '0';
                    slot.textContent = '';
                }
            });
            // Select first slot with Dirt
            this.hotbarIndex = 0;
            this.player.selectedBlock = 1;
        }
        
        this.updateHotbar();
    }

    raycastBlock() {
        const camera = this.player.getCamera();
        const direction = new THREE.Vector3(0, 0, -1);
        direction.applyQuaternion(camera.quaternion);

        const step = 0.2;
        let currentPos = camera.position.clone();
        let maxDistance = 6;
        let traveled = 0;

        // Track last empty voxel so we can place on the face we hit
        let lastEmpty = null;

        while (traveled < maxDistance) {
            currentPos.addScaledVector(direction, step);
            traveled += step;

            const x = Math.floor(currentPos.x);
            const y = Math.floor(currentPos.y);
            const z = Math.floor(currentPos.z);

            const blockType = this.world.getBlock(x, y, z);

            if (blockType === 0 || blockType === 5) {
                lastEmpty = { x, y, z }; // Remember nearest empty to place against
                continue;
            }

            // Hit a solid block: return hit plus adjacent empty spot if known
            return {
                x,
                y,
                z,
                blockType,
                distance: traveled,
                placeX: lastEmpty ? lastEmpty.x : x,
                placeY: lastEmpty ? lastEmpty.y : y + 1,
                placeZ: lastEmpty ? lastEmpty.z : z
            };
        }

        return null;
    }

    destroyBlock() {
        // Ignore if a container UI is open
        if (this.openChestPos || this.opencandlePos) return;

        const hit = this.raycastBlock();
        if (!hit) {
            this.setCrosshairProgress(0);
            return;
        }

        // Cancel any existing pending break if targeting a new block
        if (this.pendingBreak && this.pendingBreak.timeout) {
            const sameTarget = this.pendingBreak.x === hit.x && this.pendingBreak.y === hit.y && this.pendingBreak.z === hit.z;
            if (sameTarget) return; // Already breaking this block
            clearTimeout(this.pendingBreak.timeout);
            this.pendingBreak = null;
            this.setCrosshairProgress(0);
        }

        // Start delayed break (4s)
        let duration = this.getBreakDuration(hit.blockType);
        const startTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const timeout = setTimeout(() => {
            const currentType = this.world.getBlock(hit.x, hit.y, hit.z);
            if (currentType === hit.blockType) {
                this.performBlockDestruction(hit);
            }
            this.pendingBreak = null;
            this.setCrosshairProgress(0);
        }, duration);

        this.pendingBreak = { x: hit.x, y: hit.y, z: hit.z, timeout, startTime, duration };
    }

    performBlockDestruction(hit) {
        // Remove torch light if destroying a torch (type 25)
        if (hit.blockType === 25) {
            const lightKey = `${hit.x},${hit.y},${hit.z}`;
            const torchLight = this.torchLights.get(lightKey);
            if (torchLight) {
                this.scene.remove(torchLight);
                this.torchLights.delete(lightKey);
            }
        }
        
        // Drop chest contents if destroying a chest (type 26)
        if (hit.blockType === 26) {
            const chestKey = `${hit.x},${hit.y},${hit.z}`;
            const chestInventory = this.chestStorage.get(chestKey);
            if (chestInventory && this.itemManager) {
                const dropPos = new THREE.Vector3(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
                // Drop all items from chest
                for (let i = 0; i < chestInventory.length; i++) {
                    const item = chestInventory[i];
                    if (item && item !== 0) {
                        const itemType = typeof item === 'object' ? item.type : item;
                        const amount = typeof item === 'object' ? item.amount : 1;
                        this.itemManager.dropItem(dropPos, itemType, amount);
                    }
                }
            }
            // Close chest UI if it was open
            if (this.openChestPos === chestKey) {
                this.closeChestUI();
            }
            // Clear chest storage
            this.chestStorage.delete(chestKey);
        }

        // Drop candle contents if destroying a magic candle (type 29)
        if (hit.blockType === 29) {
            const candleKey = `${hit.x},${hit.y},${hit.z}`;
            const candleInv = this.candleStorage.get(candleKey);
            if (candleInv && this.itemManager) {
                const dropPos = new THREE.Vector3(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
                for (let i = 0; i < candleInv.length; i++) {
                    const item = candleInv[i];
                    if (item && item !== 0) {
                        const itemType = typeof item === 'object' ? item.type : item;
                        const amount = typeof item === 'object' ? item.amount : 1;
                        this.itemManager.dropItem(dropPos, itemType, amount);
                    }
                }
            }
            if (this.opencandlePos === candleKey) {
                this.closecandleUI();
            }
            this.candleStorage.delete(candleKey);
        }
        
        this.world.setBlock(hit.x, hit.y, hit.z, 0); // Set to air
        this.setCrosshairProgress(0);
        
        // In survival mode, add broken block to inventory
        if (this.survivalMode && hit.blockType !== 0 && hit.blockType !== 5) {
            // Try to add to existing stack of same block type
            let added = false;
            for (let i = 0; i < this.player.inventory.length; i++) {
                const slot = this.player.inventory[i];
                if (slot && slot.type === hit.blockType && slot.amount < 99) {
                    slot.amount++;
                    added = true;
                    break;
                }
            }
            // If no partial stack found, find first empty slot
            if (!added) {
                for (let i = 0; i < this.player.inventory.length; i++) {
                    if (this.player.inventory[i] === 0) {
                        this.player.inventory[i] = { type: hit.blockType, amount: 1 };
                        added = true;
                        break;
                    }
                }
            }
            // If inventory is full, log a message
            if (!added) {
                console.log('Inventory full! Block was destroyed but not collected.');
            }
            this.updateInventoryUI();
        }
        
        const cx = Math.floor(hit.x / this.world.chunkSize);
        const cz = Math.floor(hit.z / this.world.chunkSize);
        
        // Queue mesh updates instead of doing them immediately (reduces lag)
        this.queueChunkMeshUpdate(cx, cz);
        
        // Queue updates for adjacent chunks if on edge
        if (hit.x % this.world.chunkSize === 0) this.queueChunkMeshUpdate(cx - 1, cz);
        if (hit.z % this.world.chunkSize === 0) this.queueChunkMeshUpdate(cx, cz - 1);

        // Sync block destruction to server
        if (this.ws && this.ws.readyState === 1) {
            try {
                this.ws.send(JSON.stringify({
                    type: 'blockChange',
                    x: hit.x,
                    y: hit.y,
                    z: hit.z,
                    blockType: 0
                }));
            } catch {}
        }
    }

    attackPigman() {
        if (!this.pigmen || this.pigmen.length === 0) return false;

        const camera = this.player.getCamera();
        const direction = new THREE.Vector3(0, 0, -1);
        direction.applyQuaternion(camera.quaternion);

        const attackRange = 4; // Attack range
        const attackDamage = this.player.getAttackDamage(); // Get damage from equipped weapon
        
        let closestPigman = null;
        let closestDistance = attackRange;

        // Find the closest pigman in front of the player
        for (const pig of this.pigmen) {
            if (pig.isDead) continue;

            const toPigman = pig.position.clone().sub(camera.position);
            const distance = toPigman.length();

            // Check if pigman is within range
            if (distance > attackRange) continue;

            // Check if pigman is roughly in the direction player is looking
            toPigman.normalize();
            const dot = direction.dot(toPigman);
            
            if (dot > 0.7 && distance < closestDistance) { // 0.7 = ~45 degree cone
                closestPigman = pig;
                closestDistance = distance;
            }
        }

        // Check for Pigman Priest boss
        let closestPriest = null;
        let closestPriestDistance = attackRange;
        if (this.pigmanPriest && !this.pigmanPriest.isDead) {
            const toPriest = this.pigmanPriest.position.clone().sub(camera.position);
            const distance = toPriest.length();
            if (distance <= attackRange) {
                toPriest.normalize();
                const dot = direction.dot(toPriest);
                if (dot > 0.7) {
                    closestPriest = this.pigmanPriest;
                    closestPriestDistance = distance;
                }
            }
        }

        // Also check for Minutors
        let closestMinutor = null;
        let closestMinutorDistance = attackRange;

        for (const minutor of this.minutors) {
            if (minutor.isDead) continue;

            const toMinutor = minutor.position.clone().sub(camera.position);
            const distance = toMinutor.length();

            if (distance > attackRange) continue;

            toMinutor.normalize();
            const dot = direction.dot(toMinutor);
            
            if (dot > 0.7 && distance < closestMinutorDistance) {
                closestMinutor = minutor;
                closestMinutorDistance = distance;
            }
        }

        // Attack whichever is closer (prioritize boss)
        if (closestPriest && (!closestMinutor || closestPriestDistance < closestMinutorDistance) && (!closestPigman || closestPriestDistance < closestDistance)) {
            // Attack Pigman Priest Boss
            const knockbackDir = closestPriest.position.clone()
                .sub(this.player.position)
                .normalize();
            knockbackDir.y = 0;
            
            const died = closestPriest.takeDamage(attackDamage, knockbackDir);
            if (died) {
                // Drop rare loot at priest location
                if (this.itemManager) {
                    const dropPos = closestPriest.position.clone();
                    dropPos.y += 0.5;
                    // Drop golden sword and multiple pork
                    this.itemManager.dropItem(dropPos, 32, 1); // Golden sword
                    this.itemManager.dropItem(dropPos.clone().add(new THREE.Vector3(0.5, 0, 0)), 17, 10); // 10 pork
                    console.log('Pigman Priest defeated! Dropped golden sword and pork!');
                }
                
                // Remove dead priest
                if (closestPriest.mesh) {
                    this.scene.remove(closestPriest.mesh);
                }
                this.pigmanPriest = null;
            }
            return true;
        }

        if (closestMinutor && (!closestPigman || closestMinutorDistance < closestDistance)) {
            // Attack Minutor
            const knockbackDir = closestMinutor.position.clone()
                .sub(this.player.position)
                .normalize();
            knockbackDir.y = 0;
            
            const died = closestMinutor.takeDamage(attackDamage, knockbackDir);
            if (died) {
                // Drop leather items at minutor location
                if (this.itemManager) {
                    const dropPos = closestMinutor.position.clone();
                    dropPos.y += 0.5;
                    this.itemManager.dropItem(dropPos, 18, 1); // Drop leather helmet
                    console.log('Minutor dropped leather helmet!');
                }
                
                // Remove dead minutor
                if (closestMinutor.mesh) {
                    this.scene.remove(closestMinutor.mesh);
                }
                const index = this.minutors.indexOf(closestMinutor);
                if (index > -1) {
                    this.minutors.splice(index, 1);
                }
            }
            return true;
        }

        if (closestPigman) {
            // Calculate knockback direction (away from player)
            const knockbackDir = closestPigman.position.clone()
                .sub(this.player.position)
                .normalize();
            knockbackDir.y = 0; // Keep knockback horizontal
            
            const died = closestPigman.takeDamage(attackDamage, knockbackDir);
            if (died) {
                // Drop pork item at pigman location
                if (this.itemManager) {
                    const dropPos = closestPigman.position.clone();
                    dropPos.y += 0.5; // Drop slightly above ground
                    this.itemManager.dropItem(dropPos, 17, 3); // Drop 3 pork (type 17)
                    console.log('Pigman dropped 3 pork!');
                }
                
                // Remove dead pigman
                if (closestPigman.mesh) {
                    this.scene.remove(closestPigman.mesh);
                }
                const index = this.pigmen.indexOf(closestPigman);
                if (index > -1) {
                    this.pigmen.splice(index, 1);
                }
            }
            return true; // Attack hit
        }

        return false; // No pigman hit
    }

    placeBlock() {
        const hit = this.raycastBlock();
        if (hit) {
            // Open chest UI if clicking on a chest
            if (hit.blockType === 26) {
                this.openChest(hit.x, hit.y, hit.z);
                return;
            }

            // Open magic candle UI if clicking on candle
            if (hit.blockType === 29) {
                this.opencandle(hit.x, hit.y, hit.z);
                return;
            }

            // Tools like Chisel are not placeable blocks
            if (this.player.selectedBlock === 30) {
                return;
            }

            // Cloud Pillow is an item, not a placeable block
            if (this.player.selectedBlock === 31) {
                return;
            }

            // Place block in the last empty voxel we stepped through (face of the hit block)
            const px = hit.placeX;
            const py = hit.placeY;
            const pz = hit.placeZ;

            if (py >= 0 && py < this.world.chunkHeight && this.world.getBlock(px, py, pz) === 0) {
                // Check if player has the selected block in inventory
                let hasBlock = false;
                let inventorySlot = -1;
                
                if (this.survivalMode) {
                    // Find inventory slot with this block type
                    for (let i = 0; i < this.player.inventory.length; i++) {
                        const item = this.player.inventory[i];
                        if (item && typeof item === 'object' && item.type === this.player.selectedBlock && item.amount > 0) {
                            hasBlock = true;
                            inventorySlot = i;
                            break;
                        }
                    }
                    // Don't allow placing if inventory doesn't have the block
                    if (!hasBlock) {
                        console.log('You do not have this block in your inventory.');
                        return;
                    }
                }
                
                this.world.setBlock(px, py, pz, this.player.selectedBlock);
                
                // Torch placement now relies on block-light propagation (no runtime PointLight)
                if (this.player.selectedBlock === 25) {
                    // Lighting recomputed by setBlock -> recomputeLightingAround; refresh nearby meshes
                    console.log(`Placed torch at ${px},${py},${pz}; recomputing lighting`);
                }
                
                // Consume block from inventory in survival mode
                if (this.survivalMode && inventorySlot >= 0) {
                    const item = this.player.inventory[inventorySlot];
                    item.amount--;
                    if (item.amount <= 0) {
                        this.player.inventory[inventorySlot] = 0;
                    }
                    this.updateInventoryUI();
                }
                
                const cx = Math.floor(px / this.world.chunkSize);
                const cz = Math.floor(pz / this.world.chunkSize);
                
                // Queue mesh updates instead of doing them immediately (reduces lag)
                this.queueChunkMeshUpdate(cx, cz);
                
                // Queue updates for adjacent chunks if on edge
                if (px % this.world.chunkSize === 0) this.queueChunkMeshUpdate(cx - 1, cz);
                if (pz % this.world.chunkSize === 0) this.queueChunkMeshUpdate(cx, cz - 1);

                // Sync block placement to server
                if (this.ws && this.ws.readyState === 1) {
                    try {
                        this.ws.send(JSON.stringify({
                            type: 'blockChange',
                            x: px,
                            y: py,
                            z: pz,
                            blockType: this.player.selectedBlock
                        }));
                    } catch {}
                }
            }
        }
    }

    generateInitialChunks() {
        console.log('Generating initial chunks...');
        const playerChunkX = Math.floor(this.player.position.x / this.world.chunkSize);
        const playerChunkZ = Math.floor(this.player.position.z / this.world.chunkSize);
        
        console.log(`Player at chunk ${playerChunkX}, ${playerChunkZ}`);
        console.log(`Render distance: ${this.renderDistance}`);

        for (let cx = playerChunkX - this.renderDistance; cx <= playerChunkX + this.renderDistance; cx++) {
            for (let cz = playerChunkZ - this.renderDistance; cz <= playerChunkZ + this.renderDistance; cz++) {
                console.log(`Generating chunk ${cx}, ${cz}`);
                this.updateChunkMesh(cx, cz);
            }
        }
        
        console.log(`Total chunks loaded: ${this.chunkMeshes.size}`);
    }

    updateChunkMesh(cx, cz) {
        try {
            if (!this.mesher) return; // Don't create meshes until mesher is ready
            
            const key = `${cx},${cz}`;

            // Remove old mesh and any debug helpers
            if (this.chunkMeshes.has(key)) {
                const oldMesh = this.chunkMeshes.get(key);
                this.scene.remove(oldMesh);
                try { oldMesh.geometry.dispose(); } catch (e) {}
                try { oldMesh.material.dispose(); } catch (e) {}
                this.chunkBounds.delete(key);
            }
            if (meshDebugHelpers.has(key)) {
                for (const helper of meshDebugHelpers.get(key)) {
                    try { this.scene.remove(helper); } catch (e) {}
                }
                meshDebugHelpers.delete(key);
            }

            // Create new mesh with error handling
            const mesh = this.mesher.createChunkMesh(cx, cz);
            if (mesh) {
                // Mesh vertices are in local chunk coordinates (0 to chunkSize * tileSize)
                // Set mesh position to (0,0,0) since vertices already include world positions
                mesh.position.set(0, 0, 0);
                // Disable shadows in overworld to improve performance; enable in other dimensions
                const shouldCastShadow = this.world.worldType !== 'default';
                mesh.castShadow = shouldCastShadow;
                mesh.receiveShadow = shouldCastShadow;
                // If the mesh has a debug wire in geometry.userData, attach it
                if (mesh.geometry && mesh.geometry.userData && mesh.geometry.userData.debugWire) {
                    const helper = mesh.geometry.userData.debugWire;
                    mesh.add(helper);
                    if (!meshDebugHelpers.has(key)) meshDebugHelpers.set(key, []);
                    meshDebugHelpers.get(key).push(helper);
                }
                this.scene.add(mesh);
                this.chunkMeshes.set(key, mesh);

                // Precompute bounding sphere for frustum culling
                const cs = this.world.chunkSize;
                const ch = this.world.chunkHeight;
                const center = new THREE.Vector3(cx * cs + cs * 0.5, ch * 0.5, cz * cs + cs * 0.5);
                const radius = Math.sqrt((cs * cs * 0.5) + Math.pow(ch * 0.5, 2));
                this.chunkBounds.set(key, { center, radius });
            }
        } catch (e) {
            console.error(`Error updating chunk mesh ${cx},${cz}:`, e);
        }
    }

    queueChunkMeshUpdate(cx, cz) {
        // Add to queue instead of updating immediately
        const key = `${cx},${cz}`;
        // Avoid duplicate entries in queue
        if (!this.chunkMeshQueue.some(item => item.cx === cx && item.cz === cz)) {
            this.chunkMeshQueue.push({ cx, cz });
        }
    }

    // Rebuild torch lights by scanning world blocks for torch type (25)
    rebuildTorchLights() {
        // If runtime torch lights are disabled, skip rebuilding
        if (!this.useRuntimeTorchLights) return;
        const now = Date.now();
        // Throttle rebuilds to max once per 5 seconds to avoid freezing
        if (now - this.lastTorchRebuildTime < 5000) return;
        this.lastTorchRebuildTime = now;

        if (!this.scene || !this.world) return;
        if (!this.torchLights) this.torchLights = new Map();

        // Remove existing torch lights
        for (const light of this.torchLights.values()) {
            try { this.scene.remove(light); } catch {}
        }
        this.torchLights.clear();

        // Only scan chunks near player to reduce overhead
        const playerChunkX = Math.floor(this.player.position.x / this.world.chunkSize);
        const playerChunkZ = Math.floor(this.player.position.z / this.world.chunkSize);
        const scanRange = 5; // Only scan nearby chunks

        for (let cx = playerChunkX - scanRange; cx <= playerChunkX + scanRange; cx++) {
            for (let cz = playerChunkZ - scanRange; cz <= playerChunkZ + scanRange; cz++) {
                const key = `${cx},${cz}`;
                const chunk = this.world.chunks.get(key);
                if (!chunk) continue;

                for (let y = 0; y < this.world.chunkHeight; y++) {
                    for (let z = 0; z < this.world.chunkSize; z++) {
                        for (let x = 0; x < this.world.chunkSize; x++) {
                            const idx = this.world.getBlockIndex(x, y, z);
                            const blockType = chunk.blocks[idx] || 0;
                            if (blockType === 25) {
                                const wx = cx * this.world.chunkSize + x;
                                const wy = y;
                                const wz = cz * this.world.chunkSize + z;
                                const lightKey = `${wx},${wy},${wz}`;
                                const torchLight = new THREE.PointLight(0xFFAA55, 1.5, 15);
                                torchLight.position.set(wx + 0.5, wy + 0.5, wz + 0.5);
                                torchLight.castShadow = false;
                                this.scene.add(torchLight);
                                this.torchLights.set(lightKey, torchLight);
                            }
                        }
                    }
                }
            }
        }
    }

    updateVisibleChunks() {
        const playerChunkX = Math.floor(this.player.position.x / this.world.chunkSize);
        const playerChunkZ = Math.floor(this.player.position.z / this.world.chunkSize);

        // Queue chunks to generate instead of generating synchronously
        for (let cx = playerChunkX - this.renderDistance; cx <= playerChunkX + this.renderDistance; cx++) {
            for (let cz = playerChunkZ - this.renderDistance; cz <= playerChunkZ + this.renderDistance; cz++) {
                const key = `${cx},${cz}`;
                if (!this.chunkMeshes.has(key)) {
                    // Add to queue if not already there
                    if (!this.chunkMeshQueue.find(c => c.cx === cx && c.cz === cz)) {
                        this.chunkMeshQueue.push({cx, cz});
                    }
                }
            }
        }

        // Process one chunk mesh per frame from queue
        if (!this.generatingChunkMesh && this.chunkMeshQueue.length > 0) {
            const {cx, cz} = this.chunkMeshQueue.shift();
            this.generatingChunkMesh = true;
            // Use setTimeout to defer after rendering
            setTimeout(() => {
                this.updateChunkMesh(cx, cz);
                this.generatingChunkMesh = false;
            }, 0);
        }

        // Remove far chunks
        for (const [key, mesh] of this.chunkMeshes) {
            const [cx, cz] = key.split(',').map(Number);
            const dist = Math.max(Math.abs(cx - playerChunkX), Math.abs(cz - playerChunkZ));
            if (dist > this.renderDistance + 1) {
                this.scene.remove(mesh);
                mesh.geometry.dispose();
                mesh.material.dispose();
                this.chunkMeshes.delete(key);
                this.chunkBounds.delete(key);
            }
        }

        // Frustum culling: hide chunks outside camera view (throttled to every 5 frames)
        if (!this._frustumCullCounter) this._frustumCullCounter = 0;
        this._frustumCullCounter++;
        if (this._frustumCullCounter % 5 === 0) {
            const frustum = new THREE.Frustum();
            const projScreenMatrix = new THREE.Matrix4();
            projScreenMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
            frustum.setFromProjectionMatrix(projScreenMatrix);

            // Reuse sphere object to avoid allocations
            const testSphere = new THREE.Sphere();
            for (const [key, mesh] of this.chunkMeshes) {
                const bounds = this.chunkBounds.get(key);
                if (!bounds) {
                    mesh.visible = true;
                    continue;
                }
                testSphere.center.copy(bounds.center);
                testSphere.radius = bounds.radius;
                mesh.visible = frustum.intersectsSphere(testSphere);
            }
        }
    }

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    updateUI() {
        const pos = this.player.position;
        document.getElementById('fps').textContent = this.fps;
        document.getElementById('pos').textContent = `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`;
        
        const cx = Math.floor(pos.x / this.world.chunkSize);
        const cz = Math.floor(pos.z / this.world.chunkSize);
        document.getElementById('chunk').textContent = `${cx}, ${cz}`;
        
        document.getElementById('blocks').textContent = this.chunkMeshes.size;

        // Debug: show keys and velocity
        let keysText = '';
        for (const k in this.player.keys) {
            if (this.player.keys[k]) keysText += k + ' ';
        }
        if (!this._keyDebugEl) {
            this._keyDebugEl = document.createElement('div');
            this._keyDebugEl.style.position = 'absolute';
            this._keyDebugEl.style.top = '10px';
            this._keyDebugEl.style.right = '10px';
            this._keyDebugEl.style.background = 'rgba(112, 112, 112, 0.47)';
            this._keyDebugEl.style.color = '#fff';
            this._keyDebugEl.style.padding = '8px';
            this._keyDebugEl.style.fontFamily = 'monospace';
            document.body.appendChild(this._keyDebugEl);
        }
        const modeText = this.survivalMode ? ' [SURVIVAL]' : '';
        this._keyDebugEl.innerText = `Keys: ${keysText}\nVel: ${this.player.velocity.x.toFixed(2)}, ${this.player.velocity.y.toFixed(2)}, ${this.player.velocity.z.toFixed(2)}${modeText}`;
        
        // Update blindness effect
        this.updateBlindnessEffect();
    }

    updateBlindnessEffect() {
        const now = Date.now();
        
        // Create blindness overlay if it doesn't exist
        if (!this._blindnessOverlay) {
            this._blindnessOverlay = document.createElement('div');
            this._blindnessOverlay.id = 'blindness-overlay';
            this._blindnessOverlay.style.position = 'fixed';
            this._blindnessOverlay.style.top = '0';
            this._blindnessOverlay.style.left = '0';
            this._blindnessOverlay.style.width = '100%';
            this._blindnessOverlay.style.height = '100%';
            this._blindnessOverlay.style.backgroundColor = '#000000';
            this._blindnessOverlay.style.pointerEvents = 'none';
            this._blindnessOverlay.style.zIndex = '999';
            this._blindnessOverlay.style.display = 'none';
            document.body.appendChild(this._blindnessOverlay);
        }
        
        // Show or hide blindness overlay based on effect duration
        if (now < this.blindnessEndTime) {
            this._blindnessOverlay.style.display = 'block';
        } else {
            this._blindnessOverlay.style.display = 'none';
        }
    }

    applyBlindness() {
        // 37% chance to apply blindness effect for 4 seconds (4000ms)
        if (Math.random() < 0.37) {
            this.blindnessEndTime = Date.now() + 4000;
        }
    }

    // Inventory UI
    createInventoryUI() {
        if (this._inventoryEl) return;

        const inv = document.createElement('div');
        inv.id = 'inventory';
        inv.style.position = 'absolute';
        inv.style.left = '50%';
        inv.style.top = '50%';
        inv.style.transform = 'translate(-50%, -50%)';
        inv.style.padding = '12px';
        inv.style.background = 'rgba(0,0,0,0.85)';
        inv.style.border = '2px solid #666';
        inv.style.borderRadius = '8px';
        inv.style.display = 'none';
        inv.style.zIndex = '100';
        inv.style.maxWidth = '90vw';
        inv.style.maxHeight = '90vh';
        inv.style.overflowY = 'auto';

        // Add equipment slots section
        const equipmentContainer = document.createElement('div');
        equipmentContainer.style.marginBottom = '16px';
        equipmentContainer.style.padding = '12px';
        equipmentContainer.style.background = 'rgba(0,0,0,0.5)';
        equipmentContainer.style.borderRadius = '4px';

        const equipTitle = document.createElement('div');
        equipTitle.textContent = 'Equipment';
        equipTitle.style.color = '#fff';
        equipTitle.style.fontFamily = 'Arial, sans-serif';
        equipTitle.style.fontSize = '12px';
        equipTitle.style.marginBottom = '8px';
        equipmentContainer.appendChild(equipTitle);

        const equipGrid = document.createElement('div');
        equipGrid.style.display = 'grid';
        equipGrid.style.gridTemplateColumns = 'repeat(3, 60px)';
        equipGrid.style.gridGap = '8px';

        const equipSlots = [
            { key: 'head', label: 'Head' },
            { key: 'body', label: 'Body' },
            { key: 'legs', label: 'Legs' },
            { key: 'boots', label: 'Boots' },
            { key: 'mainHand', label: 'Main' },
            { key: 'offHand', label: 'Off' },
            { key: 'tool', label: 'Tool' }
        ];

        equipSlots.forEach(({ key, label }) => {
            const slotContainer = document.createElement('div');
            slotContainer.style.display = 'flex';
            slotContainer.style.flexDirection = 'column';
            slotContainer.style.alignItems = 'center';

            const slotLabel = document.createElement('div');
            slotLabel.textContent = label;
            slotLabel.style.color = '#aaa';
            slotLabel.style.fontFamily = 'Arial, sans-serif';
            slotLabel.style.fontSize = '9px';
            slotLabel.style.marginBottom = '2px';
            slotContainer.appendChild(slotLabel);

            const slot = document.createElement('div');
            slot.className = 'equip-slot';
            slot.dataset.equipSlot = key;
            slot.style.width = '60px';
            slot.style.height = '60px';
            slot.style.background = 'rgba(255,200,100,0.1)';
            slot.style.border = '2px solid #a85';
            slot.style.borderRadius = '4px';
            slot.style.display = 'flex';
            slot.style.alignItems = 'center';
            slot.style.justifyContent = 'center';
            slot.style.color = '#fff';
            slot.style.fontFamily = 'monospace';
            slot.style.fontSize = '10px';
            slot.style.cursor = 'pointer';

            // Click to unequip or place Ctrl+click item
            slot.addEventListener('click', (e) => {
                // If holding an item from Ctrl+click, place it here
                if (this._heldCtrlItem) {
                    const oldEquip = this.player.equipment[key];
                    this.player.equipment[key] = this._heldCtrlItem;
                    this._heldCtrlItem = null;
                    
                    // Put the old equipment back in inventory
                    if (oldEquip && oldEquip !== 0) {
                        for (let i = 0; i < this.player.inventory.length; i++) {
                            if (this.player.inventory[i] === 0) {
                                this.player.inventory[i] = oldEquip;
                                break;
                            }
                        }
                    }
                    this.updateInventoryUI();
                    console.log(`Equipped ${label} with Ctrl+click`);
                    return;
                }
                
                // Ctrl+click on equipment: Pick up the item
                if (e.ctrlKey) {
                    const item = this.player.equipment[key];
                    if (item && typeof item === 'object' && item.type) {
                        this._heldCtrlItem = item;
                        this.player.equipment[key] = 0;
                        this.updateInventoryUI();
                        console.log(`Picked up ${label} with Ctrl+click`);
                        return;
                    }
                }
                
                // Regular click to unequip
                const item = this.player.equipment[key];
                if (item && typeof item === 'object' && item.type) {
                    // Try to add back to inventory
                    for (let i = 0; i < this.player.inventory.length; i++) {
                        if (this.player.inventory[i] === 0) {
                            this.player.inventory[i] = item;
                            this.player.equipment[key] = 0;
                            this.updateInventoryUI();
                            console.log(`Unequipped ${label}`);
                            break;
                        }
                    }
                } else if (typeof item === 'number' && item > 0) {
                    // Try to add back to inventory
                    for (let i = 0; i < this.player.inventory.length; i++) {
                        if (this.player.inventory[i] === 0) {
                            this.player.inventory[i] = item;
                            this.player.equipment[key] = 0;
                            this.updateInventoryUI();
                            console.log(`Unequipped ${label}`);
                            break;
                        }
                    }
                }
            });

            // Accept drops from inventory
            slot.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                slot.style.background = 'rgba(255,200,100,0.3)';
            });
            slot.addEventListener('dragleave', () => {
                slot.style.background = 'rgba(255,200,100,0.1)';
            });
            slot.addEventListener('drop', (e) => {
                e.preventDefault();
                slot.style.background = 'rgba(255,200,100,0.1)';
                let srcIdx = null;
                try { srcIdx = Number(e.dataTransfer.getData('text/plain')); } catch (err) { srcIdx = null; }
                if (isNaN(srcIdx) || srcIdx === null) return;

                const item = this.player.inventory[srcIdx];
                if (item && (typeof item === 'object' || (typeof item === 'number' && item > 0))) {
                    // Swap with current equipment
                    const oldEquip = this.player.equipment[key];
                    this.player.equipment[key] = item;
                    this.player.inventory[srcIdx] = oldEquip || 0;
                    console.log(`Equipped ${label}: ${this.blockNames[item.type || item]}`);
                    this.updateInventoryUI();
                }
            });

            slotContainer.appendChild(slot);
            equipGrid.appendChild(slotContainer);
        });

        equipmentContainer.appendChild(equipGrid);
        inv.appendChild(equipmentContainer);

        // Add crafting grid in survival mode
        if (this.survivalMode) {
            const craftingContainer = document.createElement('div');
            craftingContainer.style.marginBottom = '16px';
            craftingContainer.style.padding = '12px';
            craftingContainer.style.background = 'rgba(0,0,0,0.5)';
            craftingContainer.style.borderRadius = '4px';

            const craftTitle = document.createElement('div');
            craftTitle.textContent = 'Crafting Recipes';
            craftTitle.style.color = '#fff';
            craftTitle.style.fontFamily = 'Arial, sans-serif';
            craftTitle.style.fontSize = '12px';
            craftTitle.style.marginBottom = '8px';
            craftingContainer.appendChild(craftTitle);

            // Store recipes on the instance so we can refresh availability later
            this._recipes = [
                { inputs: { 6: 1 }, result: 13, resultAmount: 2, name: '1 Wood → 2 Planks' },
                { inputs: { 13: 2 }, result: 15, resultAmount: 1, name: '2 Planks → 1 Stick' },
                { inputs: { 13: 1 }, result: 14, resultAmount: 1, name: '1 Plank → 1 Paper' },
                { inputs: { 14: 1, 15: 1 }, result: 16, resultAmount: 1, name: '1 Paper + 1 Stick → 1 Scroll' },
                { inputs: { 17: 2 }, result: 21, resultAmount: 1, name: '2 Pork → Leather Boots' },
                { inputs: { 17: 3 }, result: 20, resultAmount: 1, name: '3 Pork → Leather Leggings' },
                { inputs: { 17: 4 }, result: 18, resultAmount: 1, name: '4 Pork → Leather Helmet' },
                { inputs: { 17: 5 }, result: 19, resultAmount: 1, name: '5 Pork → Leather Chestplate' },
                { inputs: { 3: 2, 15: 1 }, result: 22, resultAmount: 1, name: '2 Stone + 1 Stick → Stone Sword' },
                { inputs: { 15: 1, 24: 1 }, result: 25, resultAmount: 1, name: '1 Stick + 1 Coal → 1 Torch' },
                { inputs: { 16: 1, 8: 1, 27: 1 }, result: 28, resultAmount: 1, name: '1 Scroll + 1 Ruby + 1 Mana Orb → 1 Fortitudo Scroll' },
                { inputs: { 16: 1, 8: 1 }, result: 35, resultAmount: 1, name: '1 Scroll + 1 Ruby → 1 Smiteth Scroll' },
                { inputs: { 1: 1, 27: 1 }, result: 36, resultAmount: 1, name: '1 Dirt + 1 Mana Orb → 1 Gloom' },
                { inputs: { 3: 1, 13: 1 }, result: 30, resultAmount: 1, name: '1 Stone + 1 Plank → 1 Chisel' },
                { inputs: { 1: 5 }, result: 31, resultAmount: 1, name: '5 Dirt → 1 Cloud Pillow' }
            ];

            // Create recipe list
            const recipeList = document.createElement('div');
            recipeList.className = 'recipe-list';
            recipeList.style.maxHeight = '200px';
            recipeList.style.overflowY = 'auto';
            recipeList.style.display = 'flex';
            recipeList.style.flexDirection = 'column';
            recipeList.style.gap = '4px';

            this._recipes.forEach((recipe, idx) => {
                const recipeBtn = document.createElement('div');
                recipeBtn.className = 'recipe-btn';
                recipeBtn.style.padding = '8px';
                recipeBtn.style.background = 'rgba(100,150,100,0.2)';
                recipeBtn.style.border = '1px solid #6a6';
                recipeBtn.style.borderRadius = '3px';
                recipeBtn.style.color = '#fff';
                recipeBtn.style.fontFamily = 'Arial, sans-serif';
                recipeBtn.style.fontSize = '11px';
                recipeBtn.style.cursor = 'pointer';
                recipeBtn.style.transition = 'background 0.2s';
                recipeBtn.textContent = recipe.name;

                const updateRecipeStyle = () => {
                    const canCraft = this.canCraftRecipe(recipe);
                    if (canCraft) {
                        recipeBtn.style.background = 'rgba(100,200,100,0.3)';
                        recipeBtn.style.borderColor = '#9f9';
                    } else {
                        recipeBtn.style.background = 'rgba(100,100,100,0.2)';
                        recipeBtn.style.borderColor = '#666';
                    }
                };

                updateRecipeStyle();

                recipeBtn.addEventListener('mouseenter', () => {
                    if (this.canCraftRecipe(recipe)) {
                        recipeBtn.style.background = 'rgba(100,255,100,0.4)';
                    }
                });

                recipeBtn.addEventListener('mouseleave', () => {
                    updateRecipeStyle();
                });

                recipeBtn.addEventListener('click', () => {
                    this.craftRecipe(recipe);
                    // Update all recipes styling after crafting
                    recipeList.querySelectorAll('.recipe-btn').forEach((btn, i) => {
                        const canCraft = this.canCraftRecipe(this._recipes[i]);
                        btn.style.background = canCraft ? 'rgba(100,200,100,0.3)' : 'rgba(100,100,100,0.2)';
                        btn.style.borderColor = canCraft ? '#9f9' : '#666';
                    });
                });

                recipeList.appendChild(recipeBtn);
            });

            craftingContainer.appendChild(recipeList);
            inv.appendChild(craftingContainer);
        }

        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = 'repeat(10, 48px)';
        grid.style.gridGap = '8px';

        // 30 slots
        for (let i = 0; i < 30; i++) {
            const slot = document.createElement('div');
            slot.className = 'inv-slot';
            slot.dataset.index = i;
            slot.style.width = '48px';
            slot.style.height = '48px';
            slot.style.background = 'rgba(255,255,255,0.06)';
            slot.style.border = '1px solid #444';
            slot.style.display = 'flex';
            slot.style.alignItems = 'center';
            slot.style.justifyContent = 'center';
            slot.style.color = '#fff';
            slot.style.fontFamily = 'monospace';
            slot.style.cursor = 'pointer';
            // click to pick
            slot.addEventListener('click', (e) => {
                const idx = Number(slot.dataset.index);
                const item = this.player.inventory[idx];
                
                // If holding an item from Ctrl+click, place it here
                if (this._heldCtrlItem) {
                    const destItem = this.player.inventory[idx];
                    
                    // Empty slot: place the held item
                    if (!destItem || destItem === 0) {
                        this.player.inventory[idx] = this._heldCtrlItem;
                        this._heldCtrlItem = null;
                        this.updateInventoryUI();
                        return;
                    }
                    
                    // Stack with same type
                    if (typeof destItem === 'object' && destItem.type === this._heldCtrlItem.type) {
                        destItem.amount += this._heldCtrlItem.amount;
                        if (destItem.amount > destItem.maxStack) {
                            destItem.amount = destItem.maxStack;
                        }
                        this._heldCtrlItem = null;
                        this.updateInventoryUI();
                        return;
                    }
                    
                    // Different item: swap
                    const temp = this.player.inventory[idx];
                    this.player.inventory[idx] = this._heldCtrlItem;
                    this._heldCtrlItem = null;
                    // Put the displaced item back where it came from if possible
                    for (let i = 0; i < this.player.inventory.length; i++) {
                        if (this.player.inventory[i] === 0) {
                            this.player.inventory[i] = temp;
                            break;
                        }
                    }
                    this.updateInventoryUI();
                    return;
                }
                
                // Ctrl+click: Pick up one item from a stack
                if (e.ctrlKey && item && typeof item === 'object' && item.type && item.amount > 0) {
                    // Store one item for placement
                    this._heldCtrlItem = new Item(item.type, 1);
                    item.amount--;
                    if (item.amount <= 0) {
                        this.player.inventory[idx] = 0;
                    }
                    this.updateInventoryUI();
                    return;
                }
                
                // Regular click to select
                if (item && typeof item === 'object' && item.type) {
                    this.player.selectedBlock = item.type;
                } else if (typeof item === 'number' && item > 0) {
                    this.player.selectedBlock = item;
                }
                this.updateHotbar();
                this.updateInventoryUI();
            });

            // enable HTML5 drag from inventory slot
            slot.draggable = true;
            slot.addEventListener('dragstart', (e) => {
                const idx = Number(slot.dataset.index);
                try { e.dataTransfer.setData('text/plain', String(idx)); } catch (err) { /* ignore */ }
                e.dataTransfer.effectAllowed = 'move';
            });
            
            // Accept drops from chest
            slot.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const data = e.dataTransfer.getData('chestSource');
                if (data) {
                    slot.style.background = 'rgba(100,200,100,0.3)';
                }
            });
            slot.addEventListener('dragleave', () => {
                slot.style.background = 'rgba(255,255,255,0.06)';
            });
            slot.addEventListener('drop', (e) => {
                e.preventDefault();
                slot.style.background = 'rgba(255,255,255,0.06)';
                
                const data = e.dataTransfer.getData('chestSource');
                if (!data) return;
                
                try {
                    const sourceData = JSON.parse(data);
                    const containerInventory = this.chestStorage.get(sourceData.chestKey) || this.candleStorage.get(sourceData.chestKey);
                    if (!containerInventory) return;
                    
                    const idx = Number(slot.dataset.index);
                    const chestItem = containerInventory[sourceData.slotIndex];
                    const invItem = this.player.inventory[idx];
                    
                    if (chestItem && chestItem !== 0) {
                        // If inventory slot is empty, move item
                        if (!invItem || invItem === 0) {
                            this.player.inventory[idx] = chestItem;
                            containerInventory[sourceData.slotIndex] = 0;
                        }
                        // If same item type, try to stack
                        else if (typeof chestItem === 'object' && typeof invItem === 'object' && chestItem.type === invItem.type) {
                            const space = 99 - invItem.amount;
                            if (space > 0) {
                                const toAdd = Math.min(space, chestItem.amount);
                                invItem.amount += toAdd;
                                chestItem.amount -= toAdd;
                                if (chestItem.amount <= 0) {
                                    containerInventory[sourceData.slotIndex] = 0;
                                }
                            }
                        }
                        // Otherwise swap items
                        else {
                            const temp = this.player.inventory[idx];
                            this.player.inventory[idx] = chestItem;
                            containerInventory[sourceData.slotIndex] = temp;
                        }
                        
                        this.updateInventoryUI();
                        // Refresh container UI to reflect changes
                        this.refreshContainerUI(sourceData.chestKey);
                    }
                } catch (err) {
                    console.error('Chest drop error:', err);
                }
            });
            
            slot.addEventListener('dragend', (e) => {
                // Check if item was dropped outside inventory
                const idx = Number(slot.dataset.index);
                const item = this.player.inventory[idx];
                
                // Get the drop target element
                const dropTarget = document.elementFromPoint(e.clientX, e.clientY);
                
                // Check if dropped outside inventory (not on inv-slot, craft-slot, or craft-result)
                const isInventorySlot = dropTarget && (
                    dropTarget.classList.contains('inv-slot') ||
                    dropTarget.classList.contains('craft-slot') ||
                    dropTarget.classList.contains('craft-result') ||
                    dropTarget.classList.contains('hotbar-slot')
                );
                
                if (!isInventorySlot && item && typeof item === 'object' && item.type) {
                    // Drop the item in the world
                    const dropPosition = this.player.position.clone();
                    // Offset slightly forward from player
                    const forwardOffset = new THREE.Vector3(0, 0, -2);
                    forwardOffset.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.player.yaw);
                    dropPosition.add(forwardOffset);
                    dropPosition.y += 0.5; // Drop at chest height
                    
                    // Drop the item using ItemManager
                    if (this.itemManager) {
                        this.itemManager.dropItem(dropPosition, item.type, item.amount);
                    }
                    
                    // Remove from inventory
                    this.player.inventory[idx] = 0;
                    this.updateInventoryUI();
                }
            });
            grid.appendChild(slot);
        }

        inv.appendChild(grid);
        
        // Mount Menu
        const mountContainer = document.createElement('div');
        mountContainer.style.marginTop = '16px';
        mountContainer.style.padding = '12px';
        mountContainer.style.background = 'rgba(0,0,0,0.5)';
        mountContainer.style.borderRadius = '4px';
        
        const mountTitle = document.createElement('div');
        mountTitle.textContent = 'Mounts';
        mountTitle.style.color = '#fff';
        mountTitle.style.fontFamily = 'Arial, sans-serif';
        mountTitle.style.fontSize = '12px';
        mountTitle.style.marginBottom = '8px';
        mountContainer.appendChild(mountTitle);
        
        const phinoxBtn = document.createElement('button');
        phinoxBtn.textContent = 'Summon Phinox';
        phinoxBtn.style.padding = '8px 16px';
        phinoxBtn.style.background = 'rgba(255,100,0,0.3)';
        phinoxBtn.style.border = '1px solid #f80';
        phinoxBtn.style.borderRadius = '4px';
        phinoxBtn.style.color = '#fff';
        phinoxBtn.style.fontFamily = 'Arial, sans-serif';
        phinoxBtn.style.fontSize = '11px';
        phinoxBtn.style.cursor = 'pointer';
        phinoxBtn.style.marginRight = '8px';
        
        phinoxBtn.addEventListener('click', () => {
            this.spawnPhinox();
            this.toggleInventory(); // Close inventory
        });
        
        mountContainer.appendChild(phinoxBtn);
        
        const dismountBtn = document.createElement('button');
        dismountBtn.textContent = 'Dismount';
        dismountBtn.style.padding = '8px 16px';
        dismountBtn.style.background = 'rgba(100,100,100,0.3)';
        dismountBtn.style.border = '1px solid #888';
        dismountBtn.style.borderRadius = '4px';
        dismountBtn.style.color = '#fff';
        dismountBtn.style.fontFamily = 'Arial, sans-serif';
        dismountBtn.style.fontSize = '11px';
        dismountBtn.style.cursor = 'pointer';
        
        dismountBtn.addEventListener('click', () => {
            if (this.isMountedOnPhinox && this.phinox) {
                this.dismountPhinox();
            }
        });
        
        mountContainer.appendChild(dismountBtn);
        
        const recallBtn = document.createElement('button');
        recallBtn.textContent = 'Recall Phinox';
        recallBtn.style.padding = '8px 16px';
        recallBtn.style.background = 'rgba(100,50,50,0.3)';
        recallBtn.style.border = '1px solid #a66';
        recallBtn.style.borderRadius = '4px';
        recallBtn.style.color = '#fff';
        recallBtn.style.fontFamily = 'Arial, sans-serif';
        recallBtn.style.fontSize = '11px';
        recallBtn.style.cursor = 'pointer';
        recallBtn.style.marginLeft = '8px';
        
        recallBtn.addEventListener('click', () => {
            if (this.phinox) {
                this.recallPhinox();
            }
        });
        
        mountContainer.appendChild(recallBtn);
        inv.appendChild(mountContainer);
        
        document.body.appendChild(inv);
        this._inventoryEl = inv;
        this._craftingGrid = this._craftingGrid || [];
        
        // Create cursor indicator for Ctrl+click held items
        const cursorIndicator = document.createElement('div');
        cursorIndicator.id = 'ctrl-cursor-indicator';
        cursorIndicator.style.position = 'fixed';
        cursorIndicator.style.pointerEvents = 'none';
        cursorIndicator.style.padding = '4px 8px';
        cursorIndicator.style.background = 'rgba(0,0,0,0.85)';
        cursorIndicator.style.border = '1px solid #6f6';
        cursorIndicator.style.borderRadius = '4px';
        cursorIndicator.style.color = '#6f6';
        cursorIndicator.style.fontFamily = 'monospace';
        cursorIndicator.style.fontSize = '11px';
        cursorIndicator.style.display = 'none';
        cursorIndicator.style.zIndex = '1000';
        document.body.appendChild(cursorIndicator);
        this._ctrlCursorIndicator = cursorIndicator;
        
        // Track mouse movement to update cursor indicator
        document.addEventListener('mousemove', (e) => {
            if (this._heldCtrlItem && this._ctrlCursorIndicator) {
                this._ctrlCursorIndicator.style.left = (e.clientX + 15) + 'px';
                this._ctrlCursorIndicator.style.top = (e.clientY + 15) + 'px';
                this._ctrlCursorIndicator.style.display = 'block';
                const itemName = this.blockNames[this._heldCtrlItem.type] || '?';
                this._ctrlCursorIndicator.textContent = `${itemName} x${this._heldCtrlItem.amount}`;
            } else if (this._ctrlCursorIndicator) {
                this._ctrlCursorIndicator.style.display = 'none';
            }
        });
        
        // Right-click to cancel Ctrl+click and return item to inventory
        inv.addEventListener('contextmenu', (e) => {
            if (this._heldCtrlItem) {
                e.preventDefault();
                // Return the held item to first available slot
                for (let i = 0; i < this.player.inventory.length; i++) {
                    const slot = this.player.inventory[i];
                    if (slot === 0) {
                        this.player.inventory[i] = this._heldCtrlItem;
                        this._heldCtrlItem = null;
                        this.updateInventoryUI();
                        break;
                    } else if (typeof slot === 'object' && slot.type === this._heldCtrlItem.type) {
                        slot.amount += this._heldCtrlItem.amount;
                        if (slot.amount > slot.maxStack) {
                            slot.amount = slot.maxStack;
                        }
                        this._heldCtrlItem = null;
                        this.updateInventoryUI();
                        break;
                    }
                }
            }
        });
        
        this.updateInventoryUI();
    }

    updateInventoryUI() {
        if (!this._inventoryEl) return;
        
        // Update equipment slots
        const equipSlots = this._inventoryEl.querySelectorAll('.equip-slot');
        equipSlots.forEach(slot => {
            const key = slot.dataset.equipSlot;
            const item = this.player.equipment[key];
            const name = this.getItemNameWithBonus(item);
            if (name) {
                const shortName = name.length > 8 ? name.substring(0, 6) + '...' : name;
                slot.textContent = shortName;
                slot.style.fontSize = '9px';
                slot.style.whiteSpace = 'pre-line';
                slot.style.textAlign = 'center';
            } else {
                slot.textContent = '';
            }
        });
        
        // Update main inventory slots
        const slots = this._inventoryEl.querySelectorAll('.inv-slot');
        slots.forEach(slot => {
            const idx = Number(slot.dataset.index);
            const item = this.player.inventory[idx];
            const name = this.getItemNameWithBonus(item);
            slot.textContent = name || '';
        });

        // Refresh recipe availability styles
        if (this.survivalMode && this._recipes) {
            const recipeList = this._inventoryEl.querySelector('.recipe-list');
            if (recipeList) {
                const buttons = recipeList.querySelectorAll('.recipe-btn');
                buttons.forEach((btn, i) => {
                    const canCraft = this.canCraftRecipe(this._recipes[i]);
                    btn.style.background = canCraft ? 'rgba(100,200,100,0.3)' : 'rgba(100,100,100,0.2)';
                    btn.style.borderColor = canCraft ? '#9f9' : '#666';
                });
            }
        }
        
        // Update crafting grid display if in survival mode
        if (this.survivalMode && this._craftingGrid) {
            const craftSlots = this._inventoryEl.querySelectorAll('.craft-slot');
            craftSlots.forEach(slot => {
                const idx = Number(slot.dataset.craftIndex);
                const item = this._craftingGrid[idx];
                if (item && typeof item === 'object' && item.type) {
                    const blockName = this.blockNames[item.type] || '';
                    slot.textContent = item.amount > 1 ? 'x' + item.amount : '✓';
                    slot.style.color = '#6f6';
                } else {
                    slot.textContent = '';
                }
            });
            
            // Update result slot display
            const resultSlot = this._inventoryEl.querySelector('.craft-result');
            if (resultSlot) {
                const recipe = this.checkCraftingRecipe();
                if (recipe) {
                    const blockName = this.blockNames[recipe.result] || '';
                    resultSlot.textContent = blockName;
                    resultSlot.style.color = '#6f6';
                    resultSlot.style.cursor = 'pointer';
                } else {
                    resultSlot.textContent = '';
                        // Crafting UI is handled by the recipe list system
                    resultSlot.style.color = '#fff';
                }
            }
        }
    }

    checkCraftingRecipe() {
        // Check if current crafting grid contents match any recipe
        // Returns {result, inputs} if match found, null otherwise
        
        if (!this._craftingGrid) return null;
        
        const recipes = [
            // 1 Wood → 2 Planks (Wood to Plank recipe)
            {
                inputs: [
                    [6], [null], [null],  // Row 1: Wood
                    [null], [null], [null],  // Row 2: empty
                    [null], [null], [null]  // Row 3: empty
                ],
                result: 13,  // Plank
                outputAmount: 2
            },
            // 2 Planks → 1 Stick
            {
                inputs: [
                    [13, 13], [null], [null],  // Row 1: 2 Planks
                    [null], [null], [null],  // Row 2: empty
                    [null], [null], [null]  // Row 3: empty
                ],
                result: 15,  // Stick
                outputAmount: 1
            },
            // 1 Plank → 1 Paper
            {
                inputs: [
                    [13], [null], [null],  // Row 1: Plank
                    [null], [null], [null],  // Row 2: empty
                    [null], [null], [null]  // Row 3: empty
                ],
                result: 14,  // Paper
                outputAmount: 1
            },
            // 1 Paper + 1 Stick → 1 Scroll
            {
                inputs: [
                    [14, 15], [null], [null],  // Row 1: Paper, Stick
                    [null], [null], [null],  // Row 2: empty
                    [null], [null], [null]  // Row 3: empty
                ],
                result: 16,  // Scroll
                outputAmount: 1
            },
            // 2 Pork → Leather Boots
            {
                inputs: [
                    [17, 17], [null], [null],  // Row 1: 2 Pork
                    [null], [null], [null],  // Row 2: empty
                    [null], [null], [null]  // Row 3: empty
                ],
                result: 21,  // Leather Boots
                outputAmount: 1
            },
            // 3 Pork → Leather Leggings
            {
                inputs: [
                    [17, 17, 17], [null], [null],  // Row 1: 3 Pork
                    [null], [null], [null],  // Row 2: empty
                    [null], [null], [null]  // Row 3: empty
                ],
                result: 20,  // Leather Leggings
                outputAmount: 1
            },
            // 4 Pork → Leather Helmet
            {
                inputs: [
                    [17, 17, 17, 17], [null], [null],  // Row 1: 4 Pork
                    [null], [null], [null],  // Row 2: empty
                    [null], [null], [null]  // Row 3: empty
                ],
                result: 18,  // Leather Helmet
                outputAmount: 1
            },
            // 5 Pork → Leather Chestplate
            {
                inputs: [
                    [17, 17, 17, 17, 17], [null], [null],  // Row 1: 5 Pork
                    [null], [null], [null],  // Row 2: empty
                    [null], [null], [null]  // Row 3: empty
                ],
                result: 19,  // Leather Chestplate
                outputAmount: 1
            },
            // 2 Stone + 1 Stick → Stone Sword
            {
                inputs: [
                    [3, 3, 15], [null], [null],  // Row 1: 2 Stone, 1 Stick
                    [null], [null], [null],  // Row 2: empty
                    [null], [null], [null]  // Row 3: empty
                ],
                result: 22,  // Stone Sword
                outputAmount: 1
            }
        ];
        
        // Collect items in crafting grid (ignore empty slots)
        const craftedItems = this._craftingGrid.filter(item => item && item.type);
        
        // Try to match recipes
        for (const recipe of recipes) {
            if (this.matchesRecipe(recipe)) {
                return recipe;
            }
        }
        
        return null;
    }

    matchesRecipe(recipe) {
        // Simple recipe matching: check if any of the crafting inputs contain items
        // This is a simplified matching system
        
        if (!this._craftingGrid) return false;
        
        // For now, just check if we have at least one wood or plank in the grid
        // and match the exact recipe configuration
        
        let hasWood = false;
        let hasPlank = false;
        let hasPaper = false;
        let hasStick = false;
        let hasPork = false;
        let hasStone = false;
        let woodCount = 0;
        let plankCount = 0;
        let paperCount = 0;
        let stickCount = 0;
        let porkCount = 0;
        let stoneCount = 0;
        
        for (let i = 0; i < this._craftingGrid.length; i++) {
            const item = this._craftingGrid[i];
            if (item && typeof item === 'object') {
                if (item.type === 6) { // Wood
                    hasWood = true;
                    woodCount += item.amount || 1;
                }
                if (item.type === 13) { // Plank
                    hasPlank = true;
                    plankCount += item.amount || 1;
                }
                if (item.type === 14) { // Paper
                    hasPaper = true;
                    paperCount += item.amount || 1;
                }
                if (item.type === 15) { // Stick
                    hasStick = true;
                    stickCount += item.amount || 1;
                }
                if (item.type === 17) { // Pork
                    hasPork = true;
                    porkCount += item.amount || 1;
                }
                if (item.type === 3) { // Stone
                    hasStone = true;
                    stoneCount += item.amount || 1;
                }
            }
        }
        
        // Wood → Plank recipe (1 wood = 2 planks)
        if (recipe.result === 13 && hasWood && woodCount > 0) {
            return true;
        }
        
        // 2 Planks → Stick recipe
        if (recipe.result === 15 && hasPlank && plankCount >= 2) {
            return true;
        }
        
        // Plank → Paper recipe (1 plank = 1 paper)
        if (recipe.result === 14 && hasPlank && plankCount > 0) {
            return true;
        }
        
        // Paper + Stick → Scroll recipe
        if (recipe.result === 16 && hasPaper && hasStick && paperCount > 0 && stickCount > 0) {
            return true;
        }
        
        // 2 Pork → Leather Boots
        if (recipe.result === 21 && hasPork && porkCount >= 2) {
            return true;
        }
        
        // 3 Pork → Leather Leggings
        if (recipe.result === 20 && hasPork && porkCount >= 3) {
            return true;
        }
        
        // 4 Pork → Leather Helmet
        if (recipe.result === 18 && hasPork && porkCount >= 4) {
            return true;
        }
        
        // 5 Pork → Leather Chestplate
        if (recipe.result === 19 && hasPork && porkCount >= 5) {
            return true;
        }
        
        // 2 Stone + 1 Stick → Stone Sword
        if (recipe.result === 22 && hasStone && hasStick && stoneCount >= 2 && stickCount >= 1) {
            return true;
        }
        
        return false;
    }

    craftItem() {
        // Execute the current crafting recipe
        if (!this.survivalMode || !this._craftingGrid) return;
        
        const recipe = this.checkCraftingRecipe();
        if (!recipe) {
            console.log('No valid recipe matched');
            return;
        }
        
        // Consume inputs from crafting grid
        if (recipe.result === 13 && recipe.outputAmount === 2) {
            // Wood → Plank recipe: consume wood, produce 2 planks
            let consumed = false;
            for (let i = 0; i < this._craftingGrid.length; i++) {
                const item = this._craftingGrid[i];
                if (item && item.type === 6) {
                    // Found wood, consume 1
                    if (item.amount > 1) {
                        item.amount--;
                    } else {
                        this._craftingGrid[i] = 0;
                    }
                    consumed = true;
                    break;
                }
            }
            
            if (!consumed) {
                console.log('Could not consume wood');
                return;
            }
            
            // Add 2 planks to inventory
            this.addToInventory(13, 2);
            console.log('Crafted 2 Planks from 1 Wood');
        } else if (recipe.result === 15 && recipe.outputAmount === 1) {
            // 2 Planks → Stick recipe: consume 2 planks, produce 1 stick
            let consumed = 0;
            for (let i = 0; i < this._craftingGrid.length && consumed < 2; i++) {
                const item = this._craftingGrid[i];
                if (item && item.type === 13) {
                    // Found plank, consume 1
                    if (item.amount > 1) {
                        item.amount--;
                    } else {
                        this._craftingGrid[i] = 0;
                    }
                    consumed++;
                }
            }
            
            if (consumed < 2) {
                console.log('Could not consume 2 planks');
                return;
            }
            
            // Add 1 stick to inventory
            this.addToInventory(15, 1);
            console.log('Crafted 1 Stick from 2 Planks');
        } else if (recipe.result === 14 && recipe.outputAmount === 1) {
            // Plank → Paper recipe: consume 1 plank, produce 1 paper
            let consumed = false;
            for (let i = 0; i < this._craftingGrid.length; i++) {
                const item = this._craftingGrid[i];
                if (item && item.type === 13) {
                    // Found plank, consume 1
                    if (item.amount > 1) {
                        item.amount--;
                    } else {
                        this._craftingGrid[i] = 0;
                    }
                    consumed = true;
                    break;
                }
            }
            
            if (!consumed) {
                console.log('Could not consume plank');
                return;
            }
            
            // Add 1 paper to inventory
            this.addToInventory(14, 1);
            console.log('Crafted 1 Paper from 1 Plank');
        } else if (recipe.result === 16 && recipe.outputAmount === 1) {
            // Paper + Stick → Scroll recipe: consume 1 paper and 1 stick, produce 1 scroll
            let consumedPaper = false;
            let consumedStick = false;
            
            for (let i = 0; i < this._craftingGrid.length; i++) {
                const item = this._craftingGrid[i];
                if (!consumedPaper && item && item.type === 14) {
                    // Found paper, consume 1
                    if (item.amount > 1) {
                        item.amount--;
                    } else {
                        this._craftingGrid[i] = 0;
                    }
                    consumedPaper = true;
                } else if (!consumedStick && item && item.type === 15) {
                    // Found stick, consume 1
                    if (item.amount > 1) {
                        item.amount--;
                    } else {
                        this._craftingGrid[i] = 0;
                    }
                    consumedStick = true;
                }
                
                if (consumedPaper && consumedStick) break;
            }
            
            if (!consumedPaper || !consumedStick) {
                console.log('Could not consume paper and stick');
                return;
            }
            
            // Add 1 scroll to inventory
            this.addToInventory(16, 1);
            console.log('Crafted 1 Scroll from 1 Paper and 1 Stick');
        } else if (recipe.result === 21 && recipe.outputAmount === 1) {
            // 2 Pork → Leather Boots
            let consumed = 0;
            for (let i = 0; i < this._craftingGrid.length && consumed < 2; i++) {
                const item = this._craftingGrid[i];
                if (item && item.type === 17) {
                    if (item.amount > 1) {
                        item.amount--;
                    } else {
                        this._craftingGrid[i] = 0;
                    }
                    consumed++;
                }
            }
            if (consumed < 2) return;
            this.addToInventory(21, 1);
            console.log('Crafted Leather Boots from 2 Pork');
        } else if (recipe.result === 20 && recipe.outputAmount === 1) {
            // 3 Pork → Leather Leggings
            let consumed = 0;
            for (let i = 0; i < this._craftingGrid.length && consumed < 3; i++) {
                const item = this._craftingGrid[i];
                if (item && item.type === 17) {
                    if (item.amount > 1) {
                        item.amount--;
                    } else {
                        this._craftingGrid[i] = 0;
                    }
                    consumed++;
                }
            }
            if (consumed < 3) return;
            this.addToInventory(20, 1);
            console.log('Crafted Leather Leggings from 3 Pork');
        } else if (recipe.result === 18 && recipe.outputAmount === 1) {
            // 4 Pork → Leather Helmet
            let consumed = 0;
            for (let i = 0; i < this._craftingGrid.length && consumed < 4; i++) {
                const item = this._craftingGrid[i];
                if (item && item.type === 17) {
                    if (item.amount > 1) {
                        item.amount--;
                    } else {
                        this._craftingGrid[i] = 0;
                    }
                    consumed++;
                }
            }
            if (consumed < 4) return;
            this.addToInventory(18, 1);
            console.log('Crafted Leather Helmet from 4 Pork');
        } else if (recipe.result === 19 && recipe.outputAmount === 1) {
            // 5 Pork → Leather Chestplate
            let consumed = 0;
            for (let i = 0; i < this._craftingGrid.length && consumed < 5; i++) {
                const item = this._craftingGrid[i];
                if (item && item.type === 17) {
                    if (item.amount > 1) {
                        item.amount--;
                    } else {
                        this._craftingGrid[i] = 0;
                    }
                    consumed++;
                }
            }
            if (consumed < 5) return;
            this.addToInventory(19, 1);
            console.log('Crafted Leather Chestplate from 5 Pork');
        } else if (recipe.result === 22 && recipe.outputAmount === 1) {
            // 2 Stone + 1 Stick → Stone Sword
            let stoneConsumed = 0;
            let stickConsumed = 0;
            for (let i = 0; i < this._craftingGrid.length && (stoneConsumed < 2 || stickConsumed < 1); i++) {
                const item = this._craftingGrid[i];
                if (item && item.type === 3 && stoneConsumed < 2) {
                    if (item.amount > 1) {
                        item.amount--;
                    } else {
                        this._craftingGrid[i] = 0;
                    }
                    stoneConsumed++;
                } else if (item && item.type === 15 && stickConsumed < 1) {
                    if (item.amount > 1) {
                        item.amount--;
                    } else {
                        this._craftingGrid[i] = 0;
                    }
                    stickConsumed++;
                }
            }
            if (stoneConsumed < 2 || stickConsumed < 1) return;
            this.addToInventory(22, 1);
            console.log('Crafted Stone Sword from 2 Stone and 1 Stick');
        }
        
        this.updateInventoryUI();
    }

    addToInventory(blockType, amount) {
        // Add items to inventory with stacking
        let remaining = amount;
        
        // First, try to add to existing stacks
        for (let i = 0; i < this.player.inventory.length && remaining > 0; i++) {
            const item = this.player.inventory[i];
            if (item && typeof item === 'object' && item.type === blockType && item.amount < 99) {
                const space = 99 - item.amount;
                const toAdd = Math.min(space, remaining);
                item.amount += toAdd;
                remaining -= toAdd;
            }
        }
        
        // Then, fill empty slots
        for (let i = 0; i < this.player.inventory.length && remaining > 0; i++) {
            if (this.player.inventory[i] === 0) {
                const toAdd = Math.min(99, remaining);
                this.player.inventory[i] = { type: blockType, amount: toAdd };
                remaining -= toAdd;
            }
        }
        
        if (remaining > 0) {
            console.log(`Inventory full! ${remaining} blocks were not added.`);
        }
    }

    setCrosshairProgress(progress) {
        const p = Math.max(0, Math.min(1, progress || 0));
        if (this.crosshairProgress === p) return;
        this.crosshairProgress = p;

        if (!this._crosshairEl) {
            this._crosshairEl = document.getElementById('crosshair');
        }
        if (!this._crosshairEl) return;

        if (p === 0) {
            this._crosshairEl.style.background = 'transparent';
            this._crosshairEl.style.borderColor = 'rgba(255,255,255,0.5)';
        } else {
            const deg = (p * 360).toFixed(1);
            this._crosshairEl.style.background = `conic-gradient(rgba(120,170,255,0.85) ${deg}deg, rgba(255,255,255,0.05) ${deg}deg)`;
            this._crosshairEl.style.borderColor = '#8fb7ff';
        }
    }

    updateBreakProgress() {
        if (this.pendingBreak && this.pendingBreak.startTime && this.pendingBreak.duration) {
            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            const elapsed = now - this.pendingBreak.startTime;
            const p = Math.max(0, Math.min(1, elapsed / this.pendingBreak.duration));
            this.setCrosshairProgress(p);
            return;
        }
        this.setCrosshairProgress(0);
    }

    getBreakDuration(blockType) {
        // Base break time: 4 seconds
        let duration = 4000;
        // If a chisel is equipped in the Tool slot, speed up breaking (50% time)
        try {
            const tool = this.player && this.player.equipment ? this.player.equipment.tool : 0;
            const hasChisel = (tool && typeof tool === 'object' && tool.type === 30) || tool === 30;
            if (hasChisel) duration *= 0.5; // 2 seconds with chisel
        } catch {}
        return duration;
    }

    giveCreativeItem(blockType, amount = 64) {
        // Add item stack to inventory and sync hotbar selection for creative picks
        this.addToInventory(blockType, amount);
        this.updateInventoryUI();

        // Ensure hotbar reflects the chosen item for immediate use
        const slots = document.querySelectorAll('.hotbar-slot');
        if (slots && slots.length) {
            const idx = this.hotbarIndex || 0;
            const slot = slots[idx];
            slot.dataset.block = blockType;
            slot.textContent = this.blockNames[blockType] || '';
            this.hotbarIndex = idx;
            this.player.selectedBlock = blockType;
            this.updateHotbar();
        } else {
            this.player.selectedBlock = blockType;
        }
    }

    canCraftRecipe(recipe) {
        // Check if inventory has all required items for this recipe
        const needed = { ...recipe.inputs };
        const inventory = this.player.inventory;

        for (const [typeStr, amount] of Object.entries(needed)) {
            const type = Number(typeStr);
            let found = 0;

            for (let i = 0; i < inventory.length; i++) {
                const item = inventory[i];
                if (item && typeof item === 'object' && item.type === type) {
                    found += item.amount || 1;
                    if (found >= amount) break;
                }
            }

            if (found < amount) return false;
        }

        return true;
    }

    craftRecipe(recipe) {
        // Consume items from inventory and add crafted result
        if (!this.survivalMode) return;

        // Check if we can craft
        if (!this.canCraftRecipe(recipe)) {
            console.log('Cannot craft: missing required items');
            return;
        }

        // Consume items from inventory
        const needed = { ...recipe.inputs };
        const inventory = this.player.inventory;

        for (const [typeStr, amount] of Object.entries(needed)) {
            const type = Number(typeStr);
            let remaining = amount;

            for (let i = 0; i < inventory.length && remaining > 0; i++) {
                const item = inventory[i];
                if (item && typeof item === 'object' && item.type === type) {
                    const toConsume = Math.min(item.amount, remaining);
                    item.amount -= toConsume;
                    remaining -= toConsume;

                    if (item.amount <= 0) {
                        inventory[i] = 0;
                    }
                }
            }
        }

        // Add crafted item to inventory
        this.addToInventory(recipe.result, recipe.resultAmount);
        console.log(`Crafted ${recipe.name}`);
        this.updateInventoryUI();
    }


    toggleInventory() {
        this.createInventoryUI();
        if (!this._inventoryEl) this.createInventoryUI();
        const open = this._inventoryEl.style.display !== 'block';
        this._inventoryEl.style.display = open ? 'block' : 'none';
        this.inventoryOpen = open;
        if (open) {
            // show mouse
            try { document.exitPointerLock(); } catch (e) {}
            this.setCrosshairProgress(0);
            } else {
                // close inventory: try re-lock pointer for convenience
                // Also close container UIs so block breaking works again
                if (this.openChestPos) this.closeChestUI();
                if (this.opencandlePos) this.closecandleUI();
                try {
                    const el = this.renderer && this.renderer.domElement;
                    if (el && document.body.contains(el) && typeof el.requestPointerLock === 'function') el.requestPointerLock();
                } catch (e) {}
            }
    }

    createPauseMenu() {
        if (this._pauseMenuEl) return;

        const menu = document.createElement('div');
        menu.id = 'pause-menu';
        menu.style.position = 'absolute';
        menu.style.left = '50%';
        menu.style.top = '50%';
        menu.style.transform = 'translate(-50%, -50%)';
        menu.style.padding = '32px';
        menu.style.background = 'rgba(0,0,0,0.9)';
        menu.style.border = '3px solid #666';
        menu.style.borderRadius = '12px';
        menu.style.display = 'none';
        menu.style.zIndex = '200';
        menu.style.minWidth = '300px';
        menu.style.textAlign = 'center';

        const title = document.createElement('h2');
        title.textContent = 'Game Paused';
        title.style.color = '#fff';
        title.style.marginTop = '0';
        title.style.marginBottom = '24px';
        title.style.fontFamily = 'Arial, sans-serif';
        menu.appendChild(title);

        const buttonStyle = {
            width: '100%',
            padding: '12px',
            margin: '8px 0',
            fontSize: '16px',
            fontWeight: 'bold',
            background: 'rgba(255,255,255,0.1)',
            border: '2px solid #888',
            borderRadius: '6px',
            color: '#fff',
            cursor: 'pointer',
            fontFamily: 'Arial, sans-serif',
            transition: 'all 0.2s'
        };

        // Resume button
        const resumeBtn = document.createElement('button');
        resumeBtn.textContent = 'Resume';
        Object.assign(resumeBtn.style, buttonStyle);
        resumeBtn.addEventListener('mouseenter', () => {
            resumeBtn.style.background = 'rgba(255,255,255,0.2)';
            resumeBtn.style.borderColor = '#aaa';
        });
        resumeBtn.addEventListener('mouseleave', () => {
            resumeBtn.style.background = 'rgba(255,255,255,0.1)';
            resumeBtn.style.borderColor = '#888';
        });
        resumeBtn.addEventListener('click', () => this.togglePauseMenu());
        menu.appendChild(resumeBtn);

        // Save World button
        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save World';
        Object.assign(saveBtn.style, buttonStyle);
        saveBtn.addEventListener('mouseenter', () => {
            saveBtn.style.background = 'rgba(100,200,100,0.3)';
            saveBtn.style.borderColor = '#6c6';
        });
        saveBtn.addEventListener('mouseleave', () => {
            saveBtn.style.background = 'rgba(255,255,255,0.1)';
            saveBtn.style.borderColor = '#888';
        });
        saveBtn.addEventListener('click', () => {
            this.saveWorld();
            saveBtn.textContent = 'Saved!';
            setTimeout(() => { saveBtn.textContent = 'Save World'; }, 1000);
        });
        menu.appendChild(saveBtn);

        // Exit button
        const exitBtn = document.createElement('button');
        exitBtn.textContent = 'Exit to Main Menu';
        Object.assign(exitBtn.style, buttonStyle);
        exitBtn.addEventListener('mouseenter', () => {
            exitBtn.style.background = 'rgba(200,100,100,0.3)';
            exitBtn.style.borderColor = '#c66';
        });
        exitBtn.addEventListener('mouseleave', () => {
            exitBtn.style.background = 'rgba(255,255,255,0.1)';
            exitBtn.style.borderColor = '#888';
        });
        exitBtn.addEventListener('click', () => {
            if (confirm('Are you sure you want to exit? Unsaved progress will be lost.')) {
                window.location.reload();
            }
        });
        menu.appendChild(exitBtn);

        document.body.appendChild(menu);
        this._pauseMenuEl = menu;
    }

    togglePauseMenu() {
        this.createPauseMenu();
        const open = this._pauseMenuEl.style.display !== 'block';
        this._pauseMenuEl.style.display = open ? 'block' : 'none';
        this.pauseMenuOpen = open;
        if (open) {
            // Show mouse and close inventory if open
            if (this._inventoryEl && this._inventoryEl.style.display === 'block') {
                this._inventoryEl.style.display = 'none';
                this.inventoryOpen = false;
            }
            // Close chest UI if open
            if (this.openChestPos) {
                this.closeChestUI();
            }
            if (this.opencandlePos) {
                this.closecandleUI();
            }
            try { document.exitPointerLock(); } catch (e) {}
        } else {
            // Resume: re-lock pointer
            try {
                const el = this.renderer && this.renderer.domElement;
                if (el && document.body.contains(el) && typeof el.requestPointerLock === 'function') el.requestPointerLock();
            } catch (e) {}
        }
    }

    createCreativeMenu() {
        if (this._creativeMenuEl) return;

        const menu = document.createElement('div');
        menu.id = 'creative-menu';
        menu.style.position = 'absolute';
        menu.style.left = '50%';
        menu.style.top = '50%';
        menu.style.transform = 'translate(-50%, -50%)';
        menu.style.padding = '20px';
        menu.style.background = 'rgba(0,0,0,0.9)';
        menu.style.border = '3px solid #666';
        menu.style.borderRadius = '12px';
        menu.style.display = 'none';
        menu.style.zIndex = '150';
        menu.style.maxHeight = '80vh';
        menu.style.overflowY = 'auto';

        const title = document.createElement('h2');
        title.textContent = 'Creative Blocks';
        title.style.color = '#fff';
        title.style.marginTop = '0';
        title.style.marginBottom = '16px';
        title.style.fontFamily = 'Arial, sans-serif';
        menu.appendChild(title);

        // Block grid
        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = 'repeat(6, 60px)';
        grid.style.gridGap = '8px';
        grid.style.marginBottom = '16px';

        // Add all non-air entries from blockNames so new items (coal, torch, chest, mana orb, scroll, magic candle) show up automatically
        const blockTypes = Object.keys(this.blockNames)
            .map(Number)
            .filter(t => t > 0)
            .sort((a, b) => a - b);

        blockTypes.forEach(blockType => {
            const blockBtn = document.createElement('button');
            const blockName = this.blockNames[blockType] || 'Block ' + blockType;
            blockBtn.textContent = blockName;
            blockBtn.style.padding = '12px';
            blockBtn.style.background = 'rgba(100,100,150,0.5)';
            blockBtn.style.border = '2px solid #555';
            blockBtn.style.borderRadius = '6px';
            blockBtn.style.color = '#fff';
            blockBtn.style.cursor = 'pointer';
            blockBtn.style.fontFamily = 'Arial, sans-serif';
            blockBtn.style.fontSize = '12px';
            blockBtn.style.transition = 'all 0.2s';

            blockBtn.addEventListener('mouseenter', () => {
                blockBtn.style.background = 'rgba(100,200,100,0.6)';
                blockBtn.style.borderColor = '#8f8';
            });
            blockBtn.addEventListener('mouseleave', () => {
                blockBtn.style.background = 'rgba(100,100,150,0.5)';
                blockBtn.style.borderColor = '#555';
            });
            blockBtn.addEventListener('click', () => {
                // Give stack to inventory and sync hotbar
                this.giveCreativeItem(blockType, 64);
                menu.style.display = 'none';
                this.creativeMenuOpen = false;
                // Re-lock pointer
                try {
                    const el = this.renderer && this.renderer.domElement;
                    if (el && document.body.contains(el) && typeof el.requestPointerLock === 'function') el.requestPointerLock();
                } catch (e) {}
            });

            grid.appendChild(blockBtn);
        });

        menu.appendChild(grid);

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'Close (C)';
        closeBtn.style.width = '100%';
        closeBtn.style.padding = '12px';
        closeBtn.style.background = 'rgba(150,100,100,0.5)';
        closeBtn.style.border = '2px solid #888';
        closeBtn.style.borderRadius = '6px';
        closeBtn.style.color = '#fff';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.fontFamily = 'Arial, sans-serif';
        closeBtn.style.fontSize = '14px';
        closeBtn.style.transition = 'all 0.2s';

        closeBtn.addEventListener('mouseenter', () => {
            closeBtn.style.background = 'rgba(200,100,100,0.6)';
            closeBtn.style.borderColor = '#caa';
        });
        closeBtn.addEventListener('mouseleave', () => {
            closeBtn.style.background = 'rgba(150,100,100,0.5)';
            closeBtn.style.borderColor = '#888';
        });
        closeBtn.addEventListener('click', () => this.toggleCreativeMenu());

        menu.appendChild(closeBtn);

        document.body.appendChild(menu);
        this._creativeMenuEl = menu;
    }

    toggleCreativeMenu() {
        if (this.survivalMode) return; // Don't allow in survival mode
        this.createCreativeMenu();
        const open = this._creativeMenuEl.style.display !== 'block';
        this._creativeMenuEl.style.display = open ? 'block' : 'none';
        this.creativeMenuOpen = open;
        if (open) {
            // Show mouse and close other menus if open
            if (this._inventoryEl && this._inventoryEl.style.display === 'block') {
                this._inventoryEl.style.display = 'none';
                this.inventoryOpen = false;
            }
            if (this._pauseMenuEl && this._pauseMenuEl.style.display === 'block') {
                this._pauseMenuEl.style.display = 'none';
                this.pauseMenuOpen = false;
            }
            try { document.exitPointerLock(); } catch (e) {}
        } else {
            // Close: re-lock pointer
            try {
                const el = this.renderer && this.renderer.domElement;
                if (el && document.body.contains(el) && typeof el.requestPointerLock === 'function') el.requestPointerLock();
            } catch (e) {}
        }
    }

    // ------- Creative Mob Spawn Menu (V) -------
    createSpawnMenu() {
        if (this._spawnMenuEl) return;

        const menu = document.createElement('div');
        menu.id = 'spawn-menu';
        menu.style.position = 'absolute';
        menu.style.left = '50%';
        menu.style.top = '50%';
        menu.style.transform = 'translate(-50%, -50%)';
        menu.style.padding = '20px';
        menu.style.background = 'rgba(0,0,0,0.9)';
        menu.style.border = '3px solid #666';
        menu.style.borderRadius = '12px';
        menu.style.display = 'none';
        menu.style.zIndex = '160';
        menu.style.maxHeight = '70vh';
        menu.style.overflowY = 'auto';

        const title = document.createElement('h2');
        title.textContent = 'Mob Spawner';
        title.style.color = '#fff';
        title.style.marginTop = '0';
        title.style.marginBottom = '16px';
        title.style.fontFamily = 'Arial, sans-serif';
        menu.appendChild(title);

        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = 'repeat(2, 180px)';
        grid.style.gridGap = '10px';
        grid.style.marginBottom = '16px';

        const makeBtn = (label, onClick) => {
            const btn = document.createElement('button');
            btn.textContent = label;
            btn.style.padding = '12px';
            btn.style.background = 'rgba(100,100,150,0.5)';
            btn.style.border = '2px solid #555';
            btn.style.borderRadius = '6px';
            btn.style.color = '#fff';
            btn.style.cursor = 'pointer';
            btn.style.fontFamily = 'Arial, sans-serif';
            btn.style.fontSize = '14px';
            btn.style.transition = 'all 0.2s';
            btn.addEventListener('mouseenter', () => {
                btn.style.background = 'rgba(100,200,100,0.6)';
                btn.style.borderColor = '#8f8';
            });
            btn.addEventListener('mouseleave', () => {
                btn.style.background = 'rgba(100,100,150,0.5)';
                btn.style.borderColor = '#555';
            });
            btn.addEventListener('click', () => {
                try { onClick(); } catch (e) { console.warn('Spawn action failed', e); }
            });
            return btn;
        };

        // Spawn Pigman near player
        grid.appendChild(makeBtn('Spawn Pigman (near player)', () => {
            const px = this.player.position.x;
            const pz = this.player.position.z;
            const pig = this.spawnPigmanAt(px, pz);
            if (!pig) console.log('Pigman spawn failed (invalid surface?)');
        }));

        // Spawn Minotaur near player (use terrain height)
        grid.appendChild(makeBtn('Spawn Minotaur (near player)', () => {
            if (!this.world) return;
            const px = this.player.position.x;
            const pz = this.player.position.z;
            const y = this.world.getTerrainHeight(Math.floor(px), Math.floor(pz));
            const m = this.spawnMinutorAt(px, y, pz);
            if (!m) console.log('Minotaur spawn failed');
        }));

        // Spawn Pigman Priest (uses predefined location)
        grid.appendChild(makeBtn('Spawn Pigman Priest (cathedral)', () => {
            this.spawnPigmanPriest();
        }));

        // Optional: Despawn all pigmen/minotaurs
        grid.appendChild(makeBtn('Despawn All Mobs', () => {
            // Remove pigmen
            if (this.pigmen && this.scene) {
                this.pigmen.forEach(p => { if (p.mesh) this.scene.remove(p.mesh); });
                this.pigmen = [];
            }
            // Remove minutors
            if (this.minutors && this.scene) {
                this.minutors.forEach(m => { if (m.mesh) this.scene.remove(m.mesh); });
                this.minutors = [];
            }
            // Remove priest
            if (this.pigmanPriest && this.pigmanPriest.mesh && this.scene) {
                this.scene.remove(this.pigmanPriest.mesh);
                this.pigmanPriest = null;
            }
            console.log('All mobs despawned');
        }));

        menu.appendChild(grid);

        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'Close (V)';
        closeBtn.style.width = '100%';
        closeBtn.style.padding = '12px';
        closeBtn.style.background = 'rgba(150,100,100,0.5)';
        closeBtn.style.border = '2px solid #888';
        closeBtn.style.borderRadius = '6px';
        closeBtn.style.color = '#fff';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.fontFamily = 'Arial, sans-serif';
        closeBtn.style.fontSize = '14px';
        closeBtn.style.transition = 'all 0.2s';
        closeBtn.addEventListener('mouseenter', () => {
            closeBtn.style.background = 'rgba(200,100,100,0.6)';
            closeBtn.style.borderColor = '#caa';
        });
        closeBtn.addEventListener('mouseleave', () => {
            closeBtn.style.background = 'rgba(150,100,100,0.5)';
            closeBtn.style.borderColor = '#888';
        });
        closeBtn.addEventListener('click', () => this.toggleSpawnMenu());

        menu.appendChild(closeBtn);

        document.body.appendChild(menu);
        this._spawnMenuEl = menu;
    }

    toggleSpawnMenu() {
        if (this.survivalMode) return; // Creative-only
        this.createSpawnMenu();
        const open = this._spawnMenuEl.style.display !== 'block';
        this._spawnMenuEl.style.display = open ? 'block' : 'none';
        this.spawnMenuOpen = open;
        if (open) {
            // Close other menus and show mouse
            if (this._inventoryEl && this._inventoryEl.style.display === 'block') {
                this._inventoryEl.style.display = 'none';
                this.inventoryOpen = false;
            }
            if (this._pauseMenuEl && this._pauseMenuEl.style.display === 'block') {
                this._pauseMenuEl.style.display = 'none';
                this.pauseMenuOpen = false;
            }
            if (this._creativeMenuEl && this._creativeMenuEl.style.display === 'block') {
                this._creativeMenuEl.style.display = 'none';
                this.creativeMenuOpen = false;
            }
            try { document.exitPointerLock(); } catch (e) {}
        } else {
            // Re-lock pointer on close
            try {
                const el = this.renderer && this.renderer.domElement;
                if (el && document.body.contains(el) && typeof el.requestPointerLock === 'function') el.requestPointerLock();
            } catch (e) {}
        }
    }

    createHealthBar() {
        if (this._healthBarEl) return;

        const container = document.createElement('div');
        container.id = 'health-bar-container';
        container.style.position = 'absolute';
        container.style.top = '20px';
        container.style.left = '20px';
        container.style.width = '200px';
        container.style.zIndex = '20';

        const label = document.createElement('div');
        label.textContent = 'Health';
        label.style.color = '#fff';
        label.style.fontFamily = 'Arial, sans-serif';
        label.style.fontSize = '14px';
        label.style.marginBottom = '4px';
        label.style.textShadow = '2px 2px 4px rgba(0,0,0,0.8)';
        container.appendChild(label);

        const barBg = document.createElement('div');
        barBg.style.width = '200px';
        barBg.style.height = '24px';
        barBg.style.background = 'rgba(0,0,0,0.5)';
        barBg.style.border = '2px solid #333';
        barBg.style.borderRadius = '4px';
        barBg.style.overflow = 'hidden';
        barBg.style.position = 'relative';

        const barFill = document.createElement('div');
        barFill.id = 'health-bar-fill';
        barFill.style.height = '100%';
        barFill.style.width = '100%';
        barFill.style.background = 'linear-gradient(to bottom, #ff4444, #cc0000)';
        barFill.style.transition = 'width 0.3s ease';
        barBg.appendChild(barFill);

        const barText = document.createElement('div');
        barText.id = 'health-bar-text';
        barText.textContent = '20/20';
        barText.style.position = 'absolute';
        barText.style.top = '50%';
        barText.style.left = '50%';
        barText.style.transform = 'translate(-50%, -50%)';
        barText.style.color = '#fff';
        barText.style.fontFamily = 'Arial, sans-serif';
        barText.style.fontSize = '12px';
        barText.style.fontWeight = 'bold';
        barText.style.textShadow = '1px 1px 2px rgba(0,0,0,0.8)';
        barBg.appendChild(barText);

        container.appendChild(barBg);
        document.body.appendChild(container);
        this._healthBarEl = container;
    }

    updateHealthBar() {
        if (!this._healthBarEl || !this.player.survivalMode) return;

        const fill = document.getElementById('health-bar-fill');
        const text = document.getElementById('health-bar-text');
        
        if (fill && text) {
            const percent = (this.player.health / this.player.maxHealth) * 100;
            fill.style.width = percent + '%';
            text.textContent = `${this.player.health}/${this.player.maxHealth}`;
            
            // Change color based on health
            if (percent > 50) {
                fill.style.background = 'linear-gradient(to bottom, #ff4444, #cc0000)';
            } else if (percent > 25) {
                fill.style.background = 'linear-gradient(to bottom, #ff8844, #dd4400)';
            } else {
                fill.style.background = 'linear-gradient(to bottom, #ff0000, #880000)';
            }
        }
    }

    openChest(cx, cy, cz) {
        const chestKey = `${cx},${cy},${cz}`;
        
        // Initialize chest storage if not exists
        if (!this.chestStorage.has(chestKey)) {
            const chestInv = new Array(20).fill(0);
            
            // Add special loot to room chest (in maze at y=20)
            if (cy === 20 && cx >= -12 && cx <= 11 && cz >= -12 && cz <= 11) {
                chestInv[0] = { type: 27, amount: 1 }; // Mana Orb
                chestInv[1] = { type: 27, amount: 1 }; // Mana Orb (2 total)
            }
            
            this.chestStorage.set(chestKey, chestInv);
        }

        this.createInventoryUI();
        if (this._inventoryEl) this._inventoryEl.style.display = 'block';
        this.openChestPos = chestKey;
        try { document.exitPointerLock(); } catch (e) {}
        this.createChestUI(cx, cy, cz);
    }

    opencandle(cx, cy, cz) {
        const key = `${cx},${cy},${cz}`;
        if (!this.candleStorage.has(key)) {
            // 3 slots: armor/tools, scrolls, result
            this.candleStorage.set(key, new Array(3).fill(0));
        }
        this.createInventoryUI();
        if (this._inventoryEl) this._inventoryEl.style.display = 'block';
        this.opencandlePos = key;
        try { document.exitPointerLock(); } catch (e) {}
        this.createcandleUI(cx, cy, cz);
    }

    createChestUI(cx, cy, cz) {
        const chestKey = `${cx},${cy},${cz}`;
        const chestInventory = this.chestStorage.get(chestKey);
        
        // Create or get chest container in inventory
        let chestWindow = document.getElementById('chest-ui');
        if (!chestWindow) {
            chestWindow = document.createElement('div');
            chestWindow.id = 'chest-ui';
            chestWindow.style.marginTop = '16px';
            chestWindow.style.padding = '12px';
            chestWindow.style.background = 'rgba(20, 20, 20, 0.8)';
            chestWindow.style.border = '2px solid #8B4513';
            chestWindow.style.borderRadius = '4px';
            chestWindow.style.fontFamily = 'Arial, sans-serif';
            chestWindow.style.color = '#FFFFFF';
            
            // Add to inventory if it exists
            const invEl = this._inventoryEl;
            if (invEl) invEl.appendChild(chestWindow);
        } else {
            // Clear existing chest slots
            chestWindow.innerHTML = '';
        }

        chestWindow.style.display = 'block';
        
        // Title
        const title = document.createElement('h2');
        title.textContent = 'Chest Storage';
        title.style.margin = '0 0 12px 0';
        title.style.fontSize = '16px';
        chestWindow.appendChild(title);
        
        // Chest slots grid (20 slots in 5x4)
        const slotsDiv = document.createElement('div');
        slotsDiv.style.display = 'grid';
        slotsDiv.style.gridTemplateColumns = 'repeat(5, 60px)';
        slotsDiv.style.gap = '8px';
        slotsDiv.style.marginBottom = '12px';
        
        for (let i = 0; i < 20; i++) {
            const slot = document.createElement('div');
            slot.className = 'chest-slot';
            slot.dataset.slotIndex = i;
            slot.style.width = '60px';
            slot.style.height = '60px';
            slot.style.background = '#4A3728';
            slot.style.border = '2px solid #654321';
            slot.style.borderRadius = '4px';
            slot.style.display = 'flex';
            slot.style.alignItems = 'center';
            slot.style.justifyContent = 'center';
            slot.style.cursor = 'move';
            slot.style.fontSize = '12px';
            slot.style.color = '#FFFFFF';
            slot.style.userSelect = 'none';
            
            // Set item text if slot has something
            if (chestInventory[i] && chestInventory[i] !== 0) {
                const item = chestInventory[i];
                const itemType = typeof item === 'object' ? item.type : item;
                const amount = typeof item === 'object' ? item.amount : 1;
                slot.textContent = this.blockNames[itemType] || 'Item';
                slot.title = amount > 1 ? `×${amount}` : '';
            }
            
            slot.draggable = true;
            slot.addEventListener('dragstart', (e) => this.chestDragStart(e, chestKey));
            slot.addEventListener('dragover', (e) => e.preventDefault());
            slot.addEventListener('drop', (e) => this.chestDrop(e, chestKey));
            
            // Click handler for gamepad support - select item from chest
            slot.addEventListener('click', (e) => {
                const slotIdx = Number(slot.dataset.slotIndex);
                const item = chestInventory[slotIdx];
                
                // If empty slot, do nothing
                if (!item || item === 0) return;
                
                // Try to add item to player inventory
                const itemType = typeof item === 'object' ? item.type : item;
                const amount = typeof item === 'object' ? item.amount : 1;
                
                let remaining = amount;
                
                // Try to stack with existing items
                for (let j = 0; j < this.player.inventory.length && remaining > 0; j++) {
                    const invSlot = this.player.inventory[j];
                    if (invSlot && typeof invSlot === 'object' && invSlot.type === itemType && invSlot.amount < invSlot.maxStack) {
                        const canAdd = invSlot.maxStack - invSlot.amount;
                        const toAdd = Math.min(remaining, canAdd);
                        invSlot.amount += toAdd;
                        remaining -= toAdd;
                    } else if (typeof invSlot === 'number' && invSlot === itemType) {
                        // Legacy numeric format
                        const canAdd = 64 - 1; // Assume max 64
                        const toAdd = Math.min(remaining, canAdd);
                        this.player.inventory[j] = { type: itemType, amount: 1 + toAdd, maxStack: 64 };
                        remaining -= toAdd;
                    }
                }
                
                // Find empty slots
                for (let j = 0; j < this.player.inventory.length && remaining > 0; j++) {
                    if (this.player.inventory[j] === 0) {
                        const toAdd = Math.min(remaining, 64);
                        this.player.inventory[j] = { type: itemType, amount: toAdd, maxStack: 64 };
                        remaining -= toAdd;
                    }
                }
                
                // Remove from chest
                if (remaining < amount) {
                    const toRemove = amount - remaining;
                    if (typeof item === 'object') {
                        item.amount -= toRemove;
                        if (item.amount <= 0) {
                            chestInventory[slotIdx] = 0;
                        }
                    } else {
                        chestInventory[slotIdx] = 0;
                    }
                    // Just update the slot display without rebuilding entire UI
                    slot.textContent = '';
                    slot.title = '';
                    const updatedItem = chestInventory[slotIdx];
                    if (updatedItem && updatedItem !== 0) {
                        const updatedType = typeof updatedItem === 'object' ? updatedItem.type : updatedItem;
                        const updatedAmount = typeof updatedItem === 'object' ? updatedItem.amount : 1;
                        slot.textContent = this.blockNames[updatedType] || 'Item';
                        slot.title = updatedAmount > 1 ? `×${updatedAmount}` : '';
                    }
                    this.updateInventoryUI();
                }
            });
            
            slotsDiv.appendChild(slot);
        }
        chestWindow.appendChild(slotsDiv);
        
        // Info text
        const info = document.createElement('p');
        info.style.margin = '0';
        info.style.fontSize = '12px';
        info.style.color = '#AAAAAA';
        info.textContent = 'Drag items to move between chest and inventory';
        chestWindow.appendChild(info);
        
        // Already added to inventory in createChestUI
        this.inventoryOpen = true;
    }

    getItemTypeValue(item) {
        if (!item) return 0;
        return typeof item === 'object' ? item.type : item;
    }

    isArmorType(type) {
        return type === 18 || type === 19 || type === 20 || type === 21;
    }

    isSwordType(type) {
        return type === 22 || type === 32; // Stone Sword or Golden Sword
    }

    getItemNameWithBonus(item) {
        if (!item) return '';
        const type = this.getItemTypeValue(item);
        const base = this.blockNames[type] || 'Item';
        let bonus = '';
        if (item && typeof item === 'object') {
            if (item.armorBonus) bonus += ` +${item.armorBonus}% Armor`;
            if (item.damageBonus) bonus += ` +${item.damageBonus}% Damage`;
            if (item.hasCurse && item.curseType === 'gloom') bonus += ` [Gloom Curse]`;
        }
        const amt = (item && typeof item === 'object' && item.amount > 1) ? ` x${item.amount}` : '';
        return base + bonus + amt;
    }

    tryProcesscandle(candleKey) {
        const inv = this.candleStorage.get(candleKey);
        if (!inv) return;

        const armorItem = inv[0];
        const scrollItem = inv[1];
        const resultItem = inv[2];

        // Only proceed if result slot is empty
        if (resultItem && resultItem !== 0) return;

        const armorType = this.getItemTypeValue(armorItem);
        const scrollType = this.getItemTypeValue(scrollItem);

        if (!this.isArmorType(armorType) && !this.isSwordType(armorType)) return;
        if (scrollType !== 28 && scrollType !== 35 && scrollType !== 36) return; // Needs Fortitudo Scroll, Smiteth Scroll, or Gloom
        
        // Check if Smiteth Scroll is for swords only
        if (scrollType === 35 && !this.isSwordType(armorType)) return;
        
        // Check if Gloom curse is for swords only
        if (scrollType === 36 && !this.isSwordType(armorType)) return;

        // Consume one scroll
        if (scrollItem && typeof scrollItem === 'object') {
            scrollItem.amount = (scrollItem.amount || 1) - 1;
            if (scrollItem.amount <= 0) {
                inv[1] = 0;
            }
        } else {
            inv[1] = 0;
        }

        // Consume the armor piece (no stacking expected)
        const baseArmor = (armorItem && typeof armorItem === 'object') ? armorItem : new Item(armorType, 1);
        inv[0] = 0;

        // Create enchanted item
        const enchanted = new Item(baseArmor.type, 1);
        enchanted.maxStack = 1;
        
        // 10% chance to receive Gloom curse as debuff
        const isCursed = Math.random() < 0.1;
        
        if (isCursed) {
            // Gloom curse: applies blindness on hit to wearer
            enchanted.hasCurse = true;
            enchanted.curseType = 'gloom';
        } else if (scrollType === 28) {
            // Fortitudo Scroll: +10% armor
            enchanted.armorBonus = (baseArmor.armorBonus || 0) + 10;
        } else if (scrollType === 35) {
            // Smiteth Scroll: +6% damage (sword only)
            enchanted.damageBonus = (baseArmor.damageBonus || 0) + 6;
        }
        
        inv[2] = enchanted;

        // Refresh UI after processing
        this.refreshContainerUI(candleKey);
        this.updateInventoryUI();
    }

    createcandleUI(cx, cy, cz) {
        const candleKey = `${cx},${cy},${cz}`;
        const candleInv = this.candleStorage.get(candleKey);

        let candleWindow = document.getElementById('candle-ui');
        if (!candleWindow) {
            candleWindow = document.createElement('div');
            candleWindow.id = 'candle-ui';
            candleWindow.style.marginTop = '16px';
            candleWindow.style.padding = '12px';
            candleWindow.style.background = 'rgba(30, 40, 70, 0.8)';
            candleWindow.style.border = '2px solid #C0C0C0';
            candleWindow.style.borderRadius = '4px';
            candleWindow.style.fontFamily = 'Arial, sans-serif';
            candleWindow.style.color = '#E6F0FF';

            const invEl = this._inventoryEl;
            if (invEl) invEl.appendChild(candleWindow);
        } else {
            candleWindow.innerHTML = '';
        }

        candleWindow.style.display = 'block';

        const title = document.createElement('h3');
        title.textContent = 'Magic candle';
        title.style.margin = '0 0 8px 0';
        title.style.fontSize = '14px';
        candleWindow.appendChild(title);

        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = 'repeat(3, 64px)';
        grid.style.gap = '8px';
        grid.style.marginBottom = '8px';

        const labels = ['Armor / Tools', 'Scrolls', 'Result'];

        for (let i = 0; i < 3; i++) {
            const cell = document.createElement('div');
            cell.style.display = 'flex';
            cell.style.flexDirection = 'column';
            cell.style.alignItems = 'center';

            const slot = document.createElement('div');
            slot.className = 'chest-slot'; // reuse chest drag/drop logic
            slot.dataset.slotIndex = i;
            slot.style.width = '64px';
            slot.style.height = '64px';
            slot.style.background = 'rgba(80,100,140,0.4)';
            slot.style.border = '2px solid #A0B8FF';
            slot.style.borderRadius = '6px';
            slot.style.display = 'flex';
            slot.style.alignItems = 'center';
            slot.style.justifyContent = 'center';
            slot.style.cursor = 'move';
            slot.style.fontSize = '12px';
            slot.style.color = '#FFFFFF';
            slot.style.userSelect = 'none';

            const item = candleInv ? candleInv[i] : 0;
            if (item && item !== 0) {
                const label = this.getItemNameWithBonus(item);
                slot.textContent = label;
                slot.title = label;
            }

            slot.draggable = true;
            slot.addEventListener('dragstart', (e) => this.chestDragStart(e, candleKey));
            slot.addEventListener('dragover', (e) => e.preventDefault());
            slot.addEventListener('drop', (e) => this.chestDrop(e, candleKey));
            
            // Click handler for gamepad support
            slot.addEventListener('click', (e) => {
                const slotIdx = Number(slot.dataset.slotIndex);
                // candle slot 2 is the result slot and can't be clicked to take
                if (slotIdx === 2) return;
                
                const item = candleInv ? candleInv[slotIdx] : 0;
                if (!item || item === 0) return;
                
                // Try to add to player inventory
                const itemType = typeof item === 'object' ? item.type : item;
                const amount = typeof item === 'object' ? item.amount : 1;
                
                let remaining = amount;
                
                // Try to stack
                for (let j = 0; j < this.player.inventory.length && remaining > 0; j++) {
                    const invSlot = this.player.inventory[j];
                    if (invSlot && typeof invSlot === 'object' && invSlot.type === itemType && invSlot.amount < invSlot.maxStack) {
                        const canAdd = invSlot.maxStack - invSlot.amount;
                        const toAdd = Math.min(remaining, canAdd);
                        invSlot.amount += toAdd;
                        remaining -= toAdd;
                    }
                }
                
                // Find empty slots
                for (let j = 0; j < this.player.inventory.length && remaining > 0; j++) {
                    if (this.player.inventory[j] === 0) {
                        const toAdd = Math.min(remaining, 64);
                        this.player.inventory[j] = { type: itemType, amount: toAdd, maxStack: 64 };
                        remaining -= toAdd;
                    }
                }
                
                // Remove from candle
                if (remaining < amount) {
                    const toRemove = amount - remaining;
                    if (typeof item === 'object') {
                        item.amount -= toRemove;
                        if (item.amount <= 0) {
                            candleInv[slotIdx] = 0;
                        }
                    } else {
                        candleInv[slotIdx] = 0;
                    }
                    // Just update the slot display without rebuilding entire UI
                    slot.textContent = '';
                    slot.title = '';
                    const updatedItem = candleInv ? candleInv[slotIdx] : 0;
                    if (updatedItem && updatedItem !== 0) {
                        const label = this.getItemNameWithBonus(updatedItem);
                        slot.textContent = label;
                        slot.title = label;
                    }
                    this.updateInventoryUI();
                }
            });

            const lbl = document.createElement('div');
            lbl.textContent = labels[i];
            lbl.style.marginTop = '6px';
            lbl.style.fontSize = '11px';
            lbl.style.color = '#C8D8FF';

            cell.appendChild(slot);
            cell.appendChild(lbl);
            grid.appendChild(cell);
        }

        candleWindow.appendChild(grid);

        const info = document.createElement('p');
        info.style.margin = '0';
        info.style.fontSize = '11px';
        info.style.color = '#A8B8D8';
        info.textContent = 'Drop items from inventory into the slots';
        candleWindow.appendChild(info);

        this.inventoryOpen = true;
    }

    closeChestUI() {
        const chestWindow = document.getElementById('chest-ui');
        if (chestWindow) chestWindow.style.display = 'none';
        this.openChestPos = null;
        if (!this.opencandlePos) this.inventoryOpen = false;
    }

    closecandleUI() {
        const candleWindow = document.getElementById('candle-ui');
        if (candleWindow) candleWindow.style.display = 'none';
        this.opencandlePos = null;
        if (!this.openChestPos) this.inventoryOpen = false;
    }

    refreshContainerUI(storageKey) {
        const coords = storageKey.split(',').map(Number);
        if (this.chestStorage.has(storageKey)) {
            this.createChestUI(...coords);
        } else if (this.candleStorage.has(storageKey)) {
            this.createcandleUI(...coords);
        }
    }

    chestDragStart(e, chestKey) {
        const slot = e.target;
        const slotIndex = parseInt(slot.dataset.slotIndex);
        const containerInventory = this.chestStorage.get(chestKey) || this.candleStorage.get(chestKey);
        if (!containerInventory) return;
        const item = containerInventory[slotIndex];
        
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('chestSource', JSON.stringify({
            chestKey, slotIndex, item
        }));
    }

    chestDrop(e, chestKey) {
        e.preventDefault();
        const slot = e.target.closest('.chest-slot');
        if (!slot) return;
        
        const dropSlotIndex = parseInt(slot.dataset.slotIndex);
        const sourceData = JSON.parse(e.dataTransfer.getData('chestSource') || '{}');
        const invIndex = Number(e.dataTransfer.getData('text/plain'));
        
        const destChest = this.chestStorage.get(chestKey) || this.candleStorage.get(chestKey);
        if (!destChest) return;

        // Case 1: dragging from another container
        if (sourceData.chestKey) {
            const sourceChest = this.chestStorage.get(sourceData.chestKey) || this.candleStorage.get(sourceData.chestKey);
            if (sourceChest) {
                const temp = destChest[dropSlotIndex];
                destChest[dropSlotIndex] = sourceChest[sourceData.slotIndex];
                sourceChest[sourceData.slotIndex] = temp;

                if (this.candleStorage.has(chestKey)) this.tryProcesscandle(chestKey);
                if (this.candleStorage.has(sourceData.chestKey)) this.tryProcesscandle(sourceData.chestKey);

                this.refreshContainerUI(chestKey);
                if (sourceData.chestKey !== chestKey) {
                    this.refreshContainerUI(sourceData.chestKey);
                }
            }
            return;
        }

        // Case 2: dragging from inventory into container
        if (!Number.isNaN(invIndex)) {
            const invItem = this.player.inventory[invIndex];
            if (!invItem || invItem === 0) return;

            const temp = destChest[dropSlotIndex];
            destChest[dropSlotIndex] = invItem;
            this.player.inventory[invIndex] = temp || 0;

            if (this.candleStorage.has(chestKey)) this.tryProcesscandle(chestKey);

            this.refreshContainerUI(chestKey);
            this.updateInventoryUI();
        }
    }

    showDeathScreen() {
        if (this._deathScreenShown) return;
        this._deathScreenShown = true;

        const screen = document.createElement('div');
        screen.style.position = 'absolute';
        screen.style.top = '0';
        screen.style.left = '0';
        screen.style.width = '100%';
        screen.style.height = '100%';
        screen.style.background = 'rgba(0,0,0,0.85)';
        screen.style.display = 'flex';
        screen.style.flexDirection = 'column';
        screen.style.alignItems = 'center';
        screen.style.justifyContent = 'center';
        screen.style.zIndex = '500';

        const title = document.createElement('h1');
        title.textContent = 'You Died!';
        title.style.color = '#ff0000';
        title.style.fontSize = '72px';
        title.style.fontFamily = 'Arial, sans-serif';
        title.style.textShadow = '4px 4px 8px rgba(0,0,0,0.8)';
        title.style.marginBottom = '40px';
        screen.appendChild(title);

        const respawnBtn = document.createElement('button');
        respawnBtn.textContent = 'Respawn';
        respawnBtn.style.padding = '16px 32px';
        respawnBtn.style.fontSize = '24px';
        respawnBtn.style.background = '#00aa00';
        respawnBtn.style.color = '#fff';
        respawnBtn.style.border = 'none';
        respawnBtn.style.borderRadius = '8px';
        respawnBtn.style.cursor = 'pointer';
        respawnBtn.style.marginRight = '16px';
        respawnBtn.addEventListener('click', () => {
            // Respawn player
            this.player.health = this.player.maxHealth;
            this.player.isDead = false;
            this.player.position.set(0, 70, 0);
            this.player.velocity.set(0, 0, 0);
            document.body.removeChild(screen);
            this._deathScreenShown = false;
        });
        screen.appendChild(respawnBtn);

        const menuBtn = document.createElement('button');
        menuBtn.textContent = 'Main Menu';
        menuBtn.style.padding = '16px 32px';
        menuBtn.style.fontSize = '24px';
        menuBtn.style.background = '#cc0000';
        menuBtn.style.color = '#fff';
        menuBtn.style.border = 'none';
        menuBtn.style.borderRadius = '8px';
        menuBtn.style.cursor = 'pointer';
        menuBtn.addEventListener('click', () => {
            window.location.reload();
        });
        screen.appendChild(menuBtn);

        document.body.appendChild(screen);
    }

    saveWorld() {
        try {
            const saveData = {
                version: 1,
                worldType: this.world.worldType,
                survivalMode: this.survivalMode,
                timestamp: Date.now(),
                playerPosition: {
                    x: this.player.position.x,
                    y: this.player.position.y,
                    z: this.player.position.z
                },
                playerYaw: this.player.yaw,
                playerPitch: this.player.pitch,
                inventory: this.player.inventory,
                equipment: this.player.equipment,
                hotbarIndex: this.hotbarIndex,
                selectedBlock: this.player.selectedBlock,
                playerHealth: this.player.health,
                dayTime: this.dayTime,
                chunks: {},
                chestStorage: Object.fromEntries(this.chestStorage)
            };

            // Only save chunks that were actually modified by player actions (placed/destroyed blocks)
            // Skip auto-generated chunks to save space
            let savedChunkCount = 0;
            for (const [key, chunk] of this.world.chunks.entries()) {
                if (chunk.modified && chunk.playerModified) {
                    // Convert to base64 to reduce JSON size
                    const blockString = btoa(String.fromCharCode.apply(null, chunk.blocks));
                    saveData.chunks[key] = {
                        cx: chunk.cx,
                        cz: chunk.cz,
                        blocks: blockString
                    };
                    savedChunkCount++;
                    
                    // Limit saved chunks to prevent overflow (save most recent modifications)
                    if (savedChunkCount >= 50) break;
                }
            }

            const jsonString = JSON.stringify(saveData);
            const sizeKB = (jsonString.length / 1024).toFixed(2);
            
            // Check if we're approaching localStorage limit (typically 5-10MB)
            if (jsonString.length > 4 * 1024 * 1024) {
                console.warn(`Save size is large: ${sizeKB} KB`);
            }

            // This overwrites the previous save
            localStorage.setItem('voxelWorldSave', jsonString);
            console.log(`World saved successfully! (${savedChunkCount} chunks, ${sizeKB} KB)`);
        } catch (e) {
            console.error('Failed to save world:', e);
            const errorMsg = e.name === 'QuotaExceededError' 
                ? 'Storage quota exceeded. Try placing/destroying fewer blocks or clear old saves.'
                : 'Failed to save world: ' + e.message;
            alert(errorMsg);
        }
    }

    updateDayNightCycle(deltaTime) {
        // Compute current time-of-day, optionally frozen or overridden for astral/fairia dimensions
        let time = this.dayTime;

        if (this.inAstralDimension) {
            // Astral is always night: lock to midnight
            time = 0.0;
            this.dayTime = time;
        } else if (this.world && this.world.worldType === 'fairia') {
            // Fairia dimension: always dark with no day/night cycle
            // Keep black sky and red fog
            this.sunLight.intensity = 0.5;
            this.ambientLight.intensity = 0.5;
            this.scene.background = new THREE.Color(0x000000); // Pure black
            this.scene.fog.color = new THREE.Color(0xFF0000); // Red fog
            this.scene.fog.density = 0.02;
            return;
        } else if (!this.freezeLighting) {
            time += deltaTime / this.dayLength;
            if (time >= 1.0) time -= 1.0;
            this.dayTime = time;
        } else {
            // Lock to noon when frozen
            time = 0.5;
        }
        
        // Calculate sun angle (0 = midnight, 0.5 = noon)
        const angle = time * Math.PI * 2;
        const sunHeight = Math.sin(angle);
        const sunX = Math.cos(angle) * 200;
        const sunY = sunHeight * 200;
        const sunZ = 100;
        
        this.sunLight.position.set(sunX, Math.max(sunY, -50), sunZ);
        
        // Calculate light intensity based on sun height
        // Day: bright, Night: dim
        let sunIntensity, ambientIntensity, skyColor, fogColor;
        
        // Astral dimension: dark night with minimal ambient so torches stand out
        if (this.inAstralDimension) {
            sunIntensity = 0.05;
            ambientIntensity = 0.15;
            skyColor = new THREE.Color(0x0a0a1a); // Deep night
            fogColor = new THREE.Color(0x050510);
        } else if (sunHeight > 0.2) {
            // Day time (sun is high)
            sunIntensity = 1.0;
            ambientIntensity = 0.8;
            skyColor = new THREE.Color(0x87CEEB); // Sky blue
            fogColor = new THREE.Color(0x87CEEB);
        } else if (sunHeight > -0.2) {
            // Sunrise/sunset (transition)
            const t = (sunHeight + 0.2) / 0.4; // 0 to 1
            sunIntensity = 0.3 + t * 0.7;
            ambientIntensity = 0.3 + t * 0.5;
            
            // Blend from night (dark blue) to sunrise (orange) to day (sky blue)
            if (sunHeight < 0) {
                // Night to sunrise
                const nightT = (sunHeight + 0.2) / 0.2;
                skyColor = new THREE.Color().lerpColors(
                    new THREE.Color(0x000033), // Dark blue night
                    new THREE.Color(0xFF6B35), // Orange sunrise
                    nightT
                );
            } else {
                // Sunrise to day
                const dayT = sunHeight / 0.2;
                skyColor = new THREE.Color().lerpColors(
                    new THREE.Color(0xFF6B35), // Orange sunrise
                    new THREE.Color(0x87CEEB), // Sky blue
                    dayT
                );
            }
            fogColor = skyColor.clone();
        } else {
            // Night time (sun is below horizon)
            sunIntensity = 0.1;
            ambientIntensity = 0.2;
            skyColor = new THREE.Color(0x000033); // Dark blue
            fogColor = new THREE.Color(0x000033);
        }
        
        this.sunLight.intensity = sunIntensity;
        this.ambientLight.intensity = ambientIntensity;
        // Feed skylight factor to voxel lightmaps so day/night affects baked light
        if (this.world) {
            this.world.sunlightFactor = Math.max(0, sunIntensity);
        }
        this.scene.background = skyColor;
        this.scene.fog.color = fogColor;
    }

    hasCloudPillowEquipped() {
        const offHand = this.player && this.player.equipment ? this.player.equipment.offHand : 0;
        const type = (offHand && typeof offHand === 'object') ? offHand.type : offHand;
        return type === 31;
    }

    isNightTime() {
        const t = this.dayTime;
        return t >= 0.75 || t < 0.25;
    }

    clearChunkMeshes() {
        if (!this.chunkMeshes) return;
        for (const mesh of this.chunkMeshes.values()) {
            try {
                this.scene.remove(mesh);
                if (mesh.geometry) mesh.geometry.dispose();
                if (mesh.material) {
                    if (Array.isArray(mesh.material)) {
                        mesh.material.forEach(m => m && m.dispose && m.dispose());
                    } else if (mesh.material.dispose) {
                        mesh.material.dispose();
                    }
                }
            } catch {}
        }
        this.chunkMeshes.clear();
        if (this.chunkBounds) this.chunkBounds.clear();
    }

    clearTorchLights() {
        if (!this.torchLights) return;
        for (const light of this.torchLights.values()) {
            try { this.scene.remove(light); } catch {}
        }
        this.torchLights.clear();
    }

    saveDimensionState() {
        // Remove visuals but keep world data so we can regenerate meshes on return
        this.clearChunkMeshes();
        this.clearTorchLights();

        return {
            world: this.world,
            dayTime: this.dayTime,
            playerPos: this.player.position.clone(),
            playerYaw: this.player.yaw,
            playerPitch: this.player.pitch,
            chestStorage: this.chestStorage,
            candleStorage: this.candleStorage
        };
    }

    enterAstralDimension() {
        if (this.inAstralDimension) return;
        if (!this.hasCloudPillowEquipped()) return;
        if (!this.isNightTime()) return;

        this.astralReturnState = this.saveDimensionState();

        // Switch to astral world (floating islands, always night)
        this.world = new VoxelWorld('astral');
        this.dayTime = 0.75;
        this.inAstralDimension = true;
        this.chunkMeshes = new Map();
        this.chunkBounds = new Map();
        this.chunkMeshQueue = [];
        this.generatingChunkMesh = false;
        this.torchLights = new Map();
        this.chestStorage = new Map();
        this.candleStorage = new Map();
        this.mesher = new BlockMesher(this.world, this.textureAtlas);
        if (this.itemManager) this.itemManager.world = this.world;

        // Place player safely above the islands (islands spawn at y=70-100, so y=110 is safe)
        this.player.position.set(0, 110, 0);
        this.player.velocity.set(0, 0, 0);
        this.player.yaw = 0;
        this.player.pitch = 0;

        this.generateInitialChunks();
        
        // Add cathedral torch lights after a brief delay to ensure chunks are rendered
        setTimeout(() => {
            if (!this.useRuntimeTorchLights) {
                console.log('Skipping cathedral PointLight setup: using lightmaps for torch lighting');
                return;
            }
            const cathedralFloorY = 75;
            const cathedralMinX = -15;
            const cathedralMaxX = 15;
            const cathedralMinZ = -15;
            const cathedralMaxZ = 15;
            const torchY = cathedralFloorY + 2;
            
            const torchPositions = [
                [cathedralMinX + 1, torchY, cathedralMinZ + 1],
                [cathedralMaxX - 1, torchY, cathedralMinZ + 1],
                [cathedralMinX + 1, torchY, cathedralMaxZ - 1],
                [cathedralMaxX - 1, torchY, cathedralMaxZ - 1]
            ];
            
            // Clear existing lights first
            if (this.torchLights) {
                for (const light of this.torchLights.values()) {
                    this.scene.remove(light);
                }
                this.torchLights.clear();
            }
            
            for (const [tx, ty, tz] of torchPositions) {
                const lightKey = `${tx},${ty},${tz}`;
                const torchLight = new THREE.PointLight(0xFFAA55, 15.0, 100); // Very bright with large range
                torchLight.position.set(tx + 0.5, ty + 0.5, tz + 0.5);
                torchLight.castShadow = false;
                torchLight.decay = 1; // Less aggressive falloff
                this.scene.add(torchLight);
                this.torchLights.set(lightKey, torchLight);
                console.log(`Added cathedral torch light at world pos: ${tx + 0.5}, ${ty + 0.5}, ${tz + 0.5}`);
                console.log(`  Light properties - intensity: ${torchLight.intensity}, distance: ${torchLight.distance}, decay: ${torchLight.decay}`);
            }
            
            console.log(`Total lights in scene: ${this.torchLights.size}`);
            console.log(`Player spawn Y: ${this.player.position.y}, Cathedral torch Y: ${torchY}`);
            console.log(`Renderer info:`, this.renderer.info);
        }, 100);
        
        // Spawn pigmen and priest boss in the astral cathedral after chunks load
        setTimeout(() => {
            this.spawnAstralPigmen(8);
            this.spawnPigmanPriest();
        }, 500);
        
        console.log('Entered astral dimension');
    }

    exitAstralDimension() {
        if (!this.inAstralDimension) return;
        if (!this.astralReturnState) return;

        // Clean up astral visuals
        this.clearChunkMeshes();
        this.clearTorchLights();

        // Restore overworld state
        const state = this.astralReturnState;
        this.world = state.world;
        this.dayTime = state.dayTime;
        this.player.position.copy(state.playerPos);
        this.player.velocity.set(0, 0, 0);
        this.player.yaw = state.playerYaw;
        this.player.pitch = state.playerPitch;
        this.chunkMeshes = new Map();
        this.chunkBounds = new Map();
        this.chunkMeshQueue = [];
        this.generatingChunkMesh = false;
        this.torchLights = new Map();
        this.chestStorage = state.chestStorage || new Map();
        this.candleStorage = state.candleStorage || new Map();
        this.mesher = new BlockMesher(this.world, this.textureAtlas);
        if (this.itemManager) this.itemManager.world = this.world;

        this.inAstralDimension = false;
        this.astralReturnState = null;

        this.generateInitialChunks();
        console.log('Returned from astral dimension');
    }

    animate = () => {
        requestAnimationFrame(this.animate);

        try {
            const deltaTime = this.clock.getDelta();

            // Poll gamepad input every frame
            this.updateGamepadInput();

            // If paused, just render current frame without updating game state
            if (this.pauseMenuOpen) {
                this.renderer.render(this.scene, this.camera);
                return;
            }
            
            // Check for death in survival mode
            if (this.survivalMode && this.player.isDead) {
                this.showDeathScreen();
                return;
            }
            
            // Update day/night cycle
            this.updateDayNightCycle(deltaTime);
            
            // Update player
            this.player.update(this.world, deltaTime);
            // Update hostile mobs
            this.updatePigmen(deltaTime);
            if (this.pigmanPriest && !this.pigmanPriest.isDead) {
                this.pigmanPriest.update(this.world, this.player, deltaTime);
            }
            this.updateMinutors(deltaTime);
            
            // Update Phinox mount
            if (this.phinox) {
                const keys = (this.player && this.player.keys) ? this.player.keys : {};
                const playerInput = this.isMountedOnPhinox ? {
                    forward: !!(keys['w'] || keys['arrowup']),
                    backward: !!(keys['s'] || keys['arrowdown']),
                    left: !!(keys['a'] || keys['arrowleft']),
                    right: !!(keys['d'] || keys['arrowright']),
                    // Spacebar is stored as a literal space in our key map
                    jump: !!(keys[' '] || keys['space']),
                    // Support generic 'shift' plus browser-specific names
                    sneak: !!(keys['shift'] || keys['shiftleft'] || keys['shiftright'])
                } : null;

                this.phinox.update(deltaTime, playerInput, this.world);
                
                // Sync player/mount when mounted: yaw from mouse (player), position from mount
                if (this.isMountedOnPhinox) {
                    this.phinox.yaw = this.player.yaw;
                    this.player.position.copy(this.phinox.position);
                    this.player.position.y += 1; // Sit on top
                    this.player.velocity.set(0, 0, 0); // Cancel player physics
                }
            }
            
            // Update dropped items
            if (this.itemManager) {
                const pickedUp = this.itemManager.update(this.player, deltaTime);
                // Update inventory UI if item was picked up
                if (pickedUp && this.inventoryOpen) {
                    this.updateInventoryUI();
                }
            }
            
            // Update visible chunks
            this.updateVisibleChunks();

            // Update block break progress fill
            this.updateBreakProgress();

            // Update camera
            if (!this.thirdPerson) {
                // First-person: use player's camera and attach hand block
                this.camera = this.player.getCamera();
                if (this.handBlock && this.handBlock.parent !== this.camera) {
                    try { this.camera.add(this.handBlock); } catch (e) {}
                }
                if (this.playerModel) this.playerModel.visible = false;

                // Update hand block (rotating held block)
                this.updateHandBlock();
            } else {
                // Third-person: orbit camera behind player using yaw for bearing and pitch for tilt
                const headOffset = new THREE.Vector3(0, 1.5, 0);
                const headPos = this.player.position.clone().add(headOffset);

                const horizontalRadius = this.thirdPersonDistance * Math.cos(this.player.pitch);
                const verticalOffset = this.thirdPersonDistance * Math.sin(this.player.pitch);

                // Direction pointing backward relative to player facing
                const behindDir = new THREE.Vector3(
                    Math.sin(this.player.yaw + Math.PI),
                    0,
                    Math.cos(this.player.yaw + Math.PI)
                );

                const desiredCamPos = headPos.clone()
                    .addScaledVector(behindDir, horizontalRadius)
                    .add(new THREE.Vector3(0, verticalOffset, 0));

                this.thirdCamera.position.copy(desiredCamPos);
                this.thirdCamera.lookAt(headPos);
                this.camera = this.thirdCamera;
                // ensure handBlock is not attached to camera in third-person
                if (this.handBlock && this.handBlock.parent) {
                    try { this.handBlock.parent.remove(this.handBlock); } catch (e) {}
                }
                if (this.playerModel) this.playerModel.visible = true;
            }

            // Update player model
            this.updatePlayerModel();

            // Animate cape if player has one
            if (this.playerCape) {
                const time = Date.now() * 0.001; // Convert to seconds
                const posAttr = this.playerCape.geometry.getAttribute('position');
                const positions = posAttr.array;
                const basePos = this.playerCape.userData.basePositions;
                
                // Apply wave animation to cape vertices
                for (let i = 0; i < positions.length; i += 3) {
                    const y = basePos[i + 1];
                    // Add wind sway based on y position (more sway at bottom)
                    const sway = Math.sin(time * 2 + y * 3) * 0.05;
                    positions[i] = basePos[i] + sway;
                    positions[i + 1] = basePos[i + 1];
                    positions[i + 2] = basePos[i + 2] + Math.cos(time * 1.5 + y * 2) * 0.03;
                }
                posAttr.needsUpdate = true;
            }

            // Update other player if multiplayer
            if (this.isMultiplayer && this.otherPlayerModel) {
                this.otherPlayerModel.position.copy(this.otherPlayer.position);
                this.otherPlayerModel.rotation.y = this.otherPlayer.yaw;
                // Make other player's name label face camera
                this.otherPlayerModel.children.forEach(child => {
                    if (child.userData.isNameLabel) {
                        child.lookAt(this.camera.position);
                    }
                });
            }

            // Update remote player models from server
            if (this.remotePlayers && this.remotePlayerModels) {
                for (const [id, playerData] of this.remotePlayers.entries()) {
                    const model = this.remotePlayerModels.get(id);
                    if (model && playerData) {
                        model.position.set(playerData.x || 0, playerData.y || 70, playerData.z || 0);
                        model.rotation.y = playerData.yaw || 0;
                        // Make name label face camera
                        model.children.forEach(child => {
                            if (child.userData.isNameLabel) {
                                child.lookAt(this.camera.position);
                            }
                        });
                    }
                }
            }

            // Render
            this.renderer.render(this.scene, this.camera);

            // FPS counter
            this.frameCount++;
            this.lastFrameTime += deltaTime;
            if (this.lastFrameTime >= 1.0) {
                this.fps = Math.round(this.frameCount / this.lastFrameTime);
                this.frameCount = 0;
                this.lastFrameTime = 0;
            }

            this.updateUI();
            
            // Update health bar in survival mode
            if (this.survivalMode) {
                this.updateHealthBar();
            }

            // Periodically send our player state to server
            if (this.ws && this.ws.readyState === 1) {
                try {
                    this.ws.send(JSON.stringify({
                        type: 'state',
                        x: this.player.position.x,
                        y: this.player.position.y,
                        z: this.player.position.z,
                        yaw: this.player.yaw
                    }));
                } catch {}
            }
        } catch (e) {
            console.error('Animation error:', e);
        }
    };
}

// Start game when page loads
window.addEventListener('load', () => {
    console.log('Window load event fired');
    console.log('THREE available:', typeof THREE !== 'undefined');
    console.log('SimplexNoise available:', typeof SimplexNoise !== 'undefined');

    if (location.protocol === 'file:') {
        console.warn('Running from file:// — browser will block loading local resources (textures, audio). Start a simple local HTTP server to avoid CORS issues (example: `python -m http.server`).');
    }

    // Create menu music
    const menuMusic = new Audio('Posey.ogg');
    menuMusic.loop = true;
    menuMusic.volume = 0.5;
    
    // Create UI click sound
    const clickSound = new Audio('ui-click.mp3');
    clickSound.volume = 0.3;
    
    // Helper function to play click sound
    const playClickSound = () => {
        clickSound.currentTime = 0;
        clickSound.play().catch(e => console.log('Click sound failed:', e));
    };
    
    // Try autoplay first
    menuMusic.play().catch(e => {
        console.log('Audio autoplay blocked:', e);
        // Start music on first user interaction
        const startMusic = () => {
            menuMusic.play().catch(err => console.log('Music play failed:', err));
            document.removeEventListener('click', startMusic);
            document.removeEventListener('keydown', startMusic);
        };
        document.addEventListener('click', startMusic);
        document.addEventListener('keydown', startMusic);
    });

    // Create background scene with terrain and spinning camera
    console.log('Creating menu background scene...');
    document.body.style.background = 'transparent';
    const menuScene = new THREE.Scene();
    menuScene.background = new THREE.Color(0x4488ff); // Bright blue to confirm it's working
    menuScene.fog = new THREE.Fog(0x4488ff, 50, 150);
    const menuCamera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    const menuRenderer = new THREE.WebGLRenderer({ antialias: true });
    menuRenderer.setSize(window.innerWidth, window.innerHeight);
    menuRenderer.domElement.style.position = 'fixed';
    menuRenderer.domElement.style.top = '0';
    menuRenderer.domElement.style.left = '0';
    menuRenderer.domElement.style.zIndex = '1';
    document.body.insertBefore(menuRenderer.domElement, document.body.firstChild);
    console.log('Menu renderer created');

    // Create simple terrain for menu background
    const menuWorld = new VoxelWorld('default');
    const menuChunks = [];
    
    // Create instanced meshes for better performance
    const grassGeometry = new THREE.BoxGeometry(1, 1, 1);
    const dirtGeometry = new THREE.BoxGeometry(1, 1, 1);
    const stoneGeometry = new THREE.BoxGeometry(1, 1, 1);
    const sandGeometry = new THREE.BoxGeometry(1, 1, 1);
    
    const dirtMaterial = new THREE.MeshLambertMaterial({ color: 0x8b5a2b });
    const grassMaterial = new THREE.MeshLambertMaterial({ color: 0x3da35a });
    const stoneMaterial = new THREE.MeshLambertMaterial({ color: 0x888888 });
    const sandMaterial = new THREE.MeshLambertMaterial({ color: 0xC2B280 });
    
    for (let cx = -2; cx <= 2; cx++) {
        for (let cz = -2; cz <= 2; cz++) {
            const chunk = menuWorld.getChunk(cx, cz);
            menuChunks.push({ cx, cz, chunk });
            
            // Simplified mesh generation for menu - only top surface blocks
            for (let x = 0; x < 16; x++) {
                for (let z = 0; z < 16; z++) {
                    const wx = cx * 16 + x;
                    const wz = cz * 16 + z;
                    const height = menuWorld.getTerrainHeight(wx, wz);
                    
                    // Get the top block type
                    const blockType = chunk.blocks[height * 256 + z * 16 + x];
                    if (blockType > 0) {
                        let material, geometry;
                        if (blockType === 1) { material = dirtMaterial; geometry = dirtGeometry; }
                        else if (blockType === 2) { material = grassMaterial; geometry = grassGeometry; }
                        else if (blockType === 3) { material = stoneMaterial; geometry = stoneGeometry; }
                        else if (blockType === 4) { material = sandMaterial; geometry = sandGeometry; }
                        else continue;
                        
                        const mesh = new THREE.Mesh(geometry, material);
                        mesh.position.set(wx, height, wz);
                        menuScene.add(mesh);
                    }
                }
            }
        }
    }

    // Add lighting
    const menuAmbient = new THREE.AmbientLight(0xffffff, 0.6);
    menuScene.add(menuAmbient);
    const menuDirectional = new THREE.DirectionalLight(0xffffff, 0.8);
    menuDirectional.position.set(1, 1, 0.5);
    menuScene.add(menuDirectional);

    // Position camera for nice view
    menuCamera.position.set(30, 45, 30);
    menuCamera.lookAt(0, 32, 0);
    
    console.log('Menu scene setup complete. Scene children:', menuScene.children.length);

    // Animation for spinning camera
    let menuAngle = 0;
    const menuAnimate = () => {
        if (!document.getElementById('main-menu')) {
            // Menu closed, stop animation and cleanup
            document.body.removeChild(menuRenderer.domElement);
            return;
        }
        
        menuAngle += 0.002;
        const radius = 40;
        menuCamera.position.x = Math.cos(menuAngle) * radius;
        menuCamera.position.z = Math.sin(menuAngle) * radius;
        menuCamera.position.y = 50;
        menuCamera.lookAt(0, 30, 0);
        
        menuRenderer.render(menuScene, menuCamera);
        requestAnimationFrame(menuAnimate);
    };

    // Handle window resize
    const menuResizeHandler = () => {
        menuCamera.aspect = window.innerWidth / window.innerHeight;
        menuCamera.updateProjectionMatrix();
        menuRenderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', menuResizeHandler);

    // Show main menu to select world type
    const menu = document.createElement('div');
    menu.id = 'main-menu';
    menu.style.position = 'absolute';
    menu.style.left = '50%';
    menu.style.top = '50%';
    menu.style.transform = 'translate(-50%, -50%)';
    menu.style.background = 'rgba(0,0,0,0.9)';
    menu.style.padding = '20px';
    menu.style.border = '2px solid #666';
    menu.style.borderRadius = '8px';
    menu.style.zIndex = '200';
    menu.style.textAlign = 'center';

    const title = document.createElement('h1');
    title.textContent = 'Voxel Placeholder';
    title.style.color = '#fff';
    title.style.fontSize = '48px';
    title.style.marginBottom = '40px';
    title.style.textShadow = '2px 2px 4px rgba(0,0,0,0.5)';
    menu.appendChild(title);

    // Main menu container (initially visible)
    const mainMenuContainer = document.createElement('div');
    mainMenuContainer.id = 'main-menu-container';
    
    // Play Game button
    const playBtn = document.createElement('button');
    playBtn.textContent = 'Play Game';
    playBtn.style.width = '250px';
    playBtn.style.margin = '12px auto';
    playBtn.style.padding = '15px';
    playBtn.style.fontSize = '20px';
    playBtn.style.background = '#00cc00';
    playBtn.style.color = '#fff';
    playBtn.style.border = 'none';
    playBtn.style.borderRadius = '8px';
    playBtn.style.cursor = 'pointer';
    playBtn.style.display = 'block';
    playBtn.addEventListener('click', () => {
        playClickSound();
        mainMenuContainer.style.display = 'none';
        settingsContainer.style.display = 'block';
    });
    mainMenuContainer.appendChild(playBtn);
    
    // Settings button
    const settingsBtn = document.createElement('button');
    settingsBtn.textContent = 'Settings';
    settingsBtn.style.width = '250px';
    settingsBtn.style.margin = '12px auto';
    settingsBtn.style.padding = '15px';
    settingsBtn.style.fontSize = '20px';
    settingsBtn.style.background = '#666';
    settingsBtn.style.color = '#fff';
    settingsBtn.style.border = 'none';
    settingsBtn.style.borderRadius = '8px';
    settingsBtn.style.cursor = 'pointer';
    settingsBtn.style.display = 'block';
    settingsBtn.addEventListener('click', () => {
        playClickSound();
        mainMenuContainer.style.display = 'none';
        settingsOnlyContainer.style.display = 'block';
    });
    mainMenuContainer.appendChild(settingsBtn);
    
    menu.appendChild(mainMenuContainer);

    // Settings container (initially hidden)
    const settingsContainer = document.createElement('div');
    settingsContainer.id = 'settings-container';
    settingsContainer.style.display = 'none';

    // Player name input
    const nameRow = document.createElement('div');
    nameRow.style.margin = '8px 0';
    const nameLabel = document.createElement('label');
    nameLabel.style.color = '#fff';
    nameLabel.textContent = 'Player Name: ';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.id = 'player-name-input';
    nameInput.placeholder = 'Enter your name';
    nameInput.value = localStorage.getItem('playerName') || 'Player';
    nameInput.style.padding = '4px';
    nameInput.style.marginLeft = '4px';
    nameLabel.appendChild(nameInput);
    nameRow.appendChild(nameLabel);
    settingsContainer.appendChild(nameRow);

    // Player email input (hidden by default, shows on click)
    const emailRow = document.createElement('div');
    emailRow.id = 'email-row';
    emailRow.style.margin = '8px 0';
    emailRow.style.display = 'none'; // Hidden by default
    const emailLabel = document.createElement('label');
    emailLabel.style.color = '#fff';
    emailLabel.textContent = 'Email: ';
    const emailInput = document.createElement('input');
    emailInput.type = 'password';
    emailInput.id = 'player-email-input';
    emailInput.placeholder = 'Enter your email';
    emailInput.value = localStorage.getItem('playerEmail') || '';
    emailInput.style.padding = '4px';
    emailInput.style.marginLeft = '4px';
    emailLabel.appendChild(emailInput);
    emailRow.appendChild(emailLabel);
    settingsContainer.appendChild(emailRow);

    // Email toggle button
    const emailToggleBtn = document.createElement('button');
    emailToggleBtn.textContent = 'Add Email';
    emailToggleBtn.style.margin = '8px';
    emailToggleBtn.style.padding = '6px 12px';
    emailToggleBtn.style.fontSize = '12px';
    emailToggleBtn.style.background = '#444';
    emailToggleBtn.style.color = '#fff';
    emailToggleBtn.style.border = 'none';
    emailToggleBtn.style.borderRadius = '4px';
    emailToggleBtn.style.cursor = 'pointer';
    emailToggleBtn.addEventListener('click', () => {
        const emailRow = document.getElementById('email-row');
        const emailInput = document.getElementById('player-email-input');
        if (emailRow.style.display === 'none') {
            emailRow.style.display = 'block';
            emailInput.type = 'password';
            emailToggleBtn.textContent = 'Show Email';
        } else {
            if (emailInput.type === 'password') {
                emailInput.type = 'email';
                emailToggleBtn.textContent = 'Hide Email';
            } else {
                emailInput.type = 'password';
                emailToggleBtn.textContent = 'Show Email';
            }
        }
    });
    settingsContainer.insertBefore(emailToggleBtn, settingsContainer.children[2]); // Insert after name input

    const makeButton = (label, type) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.margin = '8px';
        b.style.padding = '8px 16px';
        b.style.fontSize = '14px';
        b.addEventListener('click', () => {
            playClickSound();
            startGame(type);
        });
        return b;
    };

    // Player customizer section
    const customizerRow = document.createElement('div');
    customizerRow.style.margin = '16px 0';
    customizerRow.style.padding = '12px';
    customizerRow.style.background = 'rgba(50,50,50,0.5)';
    customizerRow.style.borderRadius = '4px';
    customizerRow.style.border = '1px solid #555';
    
    const customizerTitle = document.createElement('div');
    customizerTitle.textContent = 'Player Customization';
    customizerTitle.style.color = '#fff';
    customizerTitle.style.fontWeight = 'bold';
    customizerTitle.style.marginBottom = '12px';
    customizerRow.appendChild(customizerTitle);
    
    // Player color picker
    const colorRow = document.createElement('div');
    colorRow.style.margin = '8px 0';
    colorRow.style.display = 'flex';
    colorRow.style.alignItems = 'center';
    colorRow.style.justifyContent = 'center';
    
    const colorLabel = document.createElement('label');
    colorLabel.style.color = '#aaa';
    colorLabel.style.marginRight = '10px';
    colorLabel.textContent = 'Player Color:';
    colorRow.appendChild(colorLabel);
    
    const colorPicker = document.createElement('input');
    colorPicker.type = 'color';
    colorPicker.id = 'player-color-picker';
    colorPicker.value = localStorage.getItem('playerColor') || '#4488ff';
    colorPicker.style.width = '60px';
    colorPicker.style.height = '30px';
    colorPicker.style.cursor = 'pointer';
    colorPicker.style.border = 'none';
    colorPicker.style.borderRadius = '4px';
    colorRow.appendChild(colorPicker);
    
    customizerRow.appendChild(colorRow);
    settingsContainer.appendChild(customizerRow);

    // Multiplayer toggle + team selection
    const mpRow = document.createElement('div');
    mpRow.style.margin = '8px 0';
    const mpLabel = document.createElement('label');
    mpLabel.style.color = '#fff';
    const mpCheckbox = document.createElement('input');
    mpCheckbox.type = 'checkbox';
    mpCheckbox.id = 'multiplayer-checkbox';
    mpLabel.appendChild(mpCheckbox);
    mpLabel.appendChild(document.createTextNode(' Multiplayer'));
    mpRow.appendChild(mpLabel);

    const teamRow = document.createElement('div');
    teamRow.id = 'team-selection-row';
    teamRow.style.margin = '8px 0';
    teamRow.style.display = 'none'; // Hidden by default
    const redLabel = document.createElement('label');
    redLabel.style.color = '#ff9999';
    const redRadio = document.createElement('input');
    redRadio.type = 'radio';
    redRadio.name = 'team-choice';
    redRadio.value = 'red';
    redRadio.checked = true;
    redLabel.appendChild(redRadio);
    redLabel.appendChild(document.createTextNode(' Red'));
    teamRow.appendChild(redLabel);

    const blueLabel = document.createElement('label');
    blueLabel.style.color = '#9999ff';
    blueLabel.style.marginLeft = '12px';
    const blueRadio = document.createElement('input');
    blueRadio.type = 'radio';
    blueRadio.name = 'team-choice';
    blueRadio.value = 'blue';
    blueLabel.appendChild(blueRadio);
    blueLabel.appendChild(document.createTextNode(' Blue'));
    teamRow.appendChild(blueLabel);
    
    // Toggle team selection visibility when multiplayer is checked
    mpCheckbox.addEventListener('change', () => {
        teamRow.style.display = mpCheckbox.checked ? 'block' : 'none';
    });

    settingsContainer.appendChild(mpRow);
    settingsContainer.appendChild(teamRow);

    // Survival mode toggle
    const survivalRow = document.createElement('div');
    survivalRow.style.margin = '12px 0';
    survivalRow.style.padding = '8px';
    survivalRow.style.background = 'rgba(100,50,50,0.3)';
    survivalRow.style.borderRadius = '4px';
    survivalRow.style.border = '1px solid #844';
    const survivalLabel = document.createElement('label');
    survivalLabel.style.color = '#ffaaaa';
    survivalLabel.style.fontWeight = 'bold';
    const survivalCheckbox = document.createElement('input');
    survivalCheckbox.type = 'checkbox';
    survivalCheckbox.id = 'survival-checkbox';
    survivalLabel.appendChild(survivalCheckbox);
    survivalLabel.appendChild(document.createTextNode(' Survival Mode'));
    survivalRow.appendChild(survivalLabel);
    settingsContainer.appendChild(survivalRow);

    // Online server section
    const serverLabel = document.createElement('label');
    serverLabel.style.color = '#fff';
    serverLabel.style.display = 'block';
    serverLabel.style.margin = '12px 0 8px 0';
    const serverCheckbox = document.createElement('input');
    serverCheckbox.type = 'checkbox';
    serverCheckbox.id = 'server-enabled-checkbox';
    serverLabel.appendChild(serverCheckbox);
    serverLabel.appendChild(document.createTextNode(' Connect to Online Server'));
    settingsContainer.appendChild(serverLabel);

    // Server host input
    const hostRow = document.createElement('div');
    hostRow.style.margin = '8px 0';
    hostRow.style.display = 'none';
    hostRow.id = 'server-host-row';
    const hostLabel = document.createElement('label');
    hostLabel.style.color = '#aaa';
    hostLabel.textContent = 'Server Host: ';
    const hostInput = document.createElement('input');
    hostInput.type = 'text';
    hostInput.id = 'menu-server-host';
    hostInput.placeholder = 'localhost';
    hostInput.value = localStorage.getItem('serverHost') || 'localhost';
    hostInput.style.padding = '4px';
    hostInput.style.marginLeft = '4px';
    hostInput.style.width = '150px';
    hostLabel.appendChild(hostInput);
    hostRow.appendChild(hostLabel);
    settingsContainer.appendChild(hostRow);

    // Server port input
    const portRow = document.createElement('div');
    portRow.style.margin = '8px 0';
    portRow.style.display = 'none';
    portRow.id = 'server-port-row';
    const portLabel = document.createElement('label');
    portLabel.style.color = '#aaa';
    portLabel.textContent = 'Server Port: ';
    const portInput = document.createElement('input');
    portInput.type = 'number';
    portInput.id = 'menu-server-port';
    portInput.placeholder = '8080';
    portInput.value = localStorage.getItem('serverPort') || '8080';
    portInput.style.padding = '4px';
    portInput.style.marginLeft = '4px';
    portInput.style.width = '100px';
    portLabel.appendChild(portInput);
    portRow.appendChild(portLabel);
    settingsContainer.appendChild(portRow);

    // Toggle server fields visibility
    serverCheckbox.addEventListener('change', () => {
        const hostRow = document.getElementById('server-host-row');
        const portRow = document.getElementById('server-port-row');
        const savedRow = document.getElementById('saved-servers-row');
        if (serverCheckbox.checked) {
            hostRow.style.display = 'block';
            portRow.style.display = 'block';
            savedRow.style.display = 'block';
        } else {
            hostRow.style.display = 'none';
            portRow.style.display = 'none';
            savedRow.style.display = 'none';
        }
    });

    // Saved servers section
    const savedRow = document.createElement('div');
    savedRow.id = 'saved-servers-row';
    savedRow.style.margin = '12px 0';
    savedRow.style.display = 'none';
    savedRow.style.borderTop = '1px solid #555';
    savedRow.style.paddingTop = '8px';
    
    const savedLabel = document.createElement('div');
    savedLabel.style.color = '#aaa';
    savedLabel.style.fontSize = '12px';
    savedLabel.textContent = 'Saved Servers:';
    savedRow.appendChild(savedLabel);

    // Load saved servers from localStorage
    let savedServers = [];
    try {
        const stored = localStorage.getItem('savedServers');
        if (stored) savedServers = JSON.parse(stored);
    } catch (e) {}

    // Display saved servers
    const serverList = document.createElement('div');
    serverList.id = 'server-list';
    serverList.style.marginTop = '8px';
    
    function renderSavedServers() {
        serverList.innerHTML = '';
        if (savedServers.length === 0) {
            const empty = document.createElement('div');
            empty.style.color = '#666';
            empty.style.fontSize = '11px';
            empty.textContent = '(none saved)';
            serverList.appendChild(empty);
        } else {
            savedServers.forEach((server, idx) => {
                const serverDiv = document.createElement('div');
                serverDiv.style.background = 'rgba(0,0,0,0.5)';
                serverDiv.style.padding = '6px';
                serverDiv.style.margin = '4px 0';
                serverDiv.style.borderRadius = '3px';
                serverDiv.style.display = 'flex';
                serverDiv.style.justifyContent = 'space-between';
                serverDiv.style.alignItems = 'center';
                
                const info = document.createElement('span');
                info.style.color = '#aaa';
                info.style.fontSize = '11px';
                info.textContent = `${server.name || server.host}:${server.port}`;
                serverDiv.appendChild(info);
                
                const useBtn = document.createElement('button');
                useBtn.textContent = 'Use';
                useBtn.style.padding = '2px 8px';
                useBtn.style.margin = '0 4px';
                useBtn.style.fontSize = '10px';
                useBtn.style.background = '#0066cc';
                useBtn.style.color = '#fff';
                useBtn.style.border = 'none';
                useBtn.style.borderRadius = '3px';
                useBtn.style.cursor = 'pointer';
                useBtn.addEventListener('click', () => {
                    document.getElementById('menu-server-host').value = server.host;
                    document.getElementById('menu-server-port').value = server.port;
                });
                serverDiv.appendChild(useBtn);

                // Join button - quick connect
                const joinBtn = document.createElement('button');
                joinBtn.textContent = 'Join';
                joinBtn.style.padding = '2px 8px';
                joinBtn.style.margin = '0 2px';
                joinBtn.style.fontSize = '10px';
                joinBtn.style.background = '#00aa00';
                joinBtn.style.color = '#fff';
                joinBtn.style.border = 'none';
                joinBtn.style.borderRadius = '3px';
                joinBtn.style.cursor = 'pointer';
                joinBtn.addEventListener('click', () => {
                    // Start game and connect to this server
                    const playerName = document.getElementById('player-name-input').value || 'Player';
                    const playerEmail = document.getElementById('player-email-input').value || '';
                    localStorage.setItem('playerName', playerName);
                    localStorage.setItem('playerEmail', playerEmail);
                    localStorage.setItem('serverHost', server.host);
                    localStorage.setItem('serverPort', server.port);
                    document.body.removeChild(menu);
                    const game = new Game('default', false, 'red', playerName);
                    window._game = game;
                    game.connectServer(server.host, server.port);
                });
                serverDiv.appendChild(joinBtn);
                
                const delBtn = document.createElement('button');
                delBtn.textContent = 'X';
                delBtn.style.padding = '2px 6px';
                delBtn.style.fontSize = '10px';
                delBtn.style.background = '#cc0000';
                delBtn.style.color = '#fff';
                delBtn.style.border = 'none';
                delBtn.style.borderRadius = '3px';
                delBtn.style.cursor = 'pointer';
                delBtn.addEventListener('click', () => {
                    savedServers.splice(idx, 1);
                    localStorage.setItem('savedServers', JSON.stringify(savedServers));
                    renderSavedServers();
                });
                serverDiv.appendChild(delBtn);
                
                serverList.appendChild(serverDiv);
            });
        }
    }
    
    renderSavedServers();
    savedRow.appendChild(serverList);

    // Button container for Save and Join
    const btnContainer = document.createElement('div');
    btnContainer.style.display = 'flex';
    btnContainer.style.gap = '8px';
    btnContainer.style.marginTop = '8px';

    // Add/Save button
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save Server';
    saveBtn.style.flex = '1';
    saveBtn.style.padding = '6px';
    saveBtn.style.background = '#0066cc';
    saveBtn.style.color = '#fff';
    saveBtn.style.border = 'none';
    saveBtn.style.borderRadius = '3px';
    saveBtn.style.cursor = 'pointer';
    saveBtn.addEventListener('click', () => {
        const host = document.getElementById('menu-server-host').value || 'localhost';
        const port = parseInt(document.getElementById('menu-server-port').value, 10) || 8080;
        const name = `${host}:${port}`;
        
        // Check if already saved
        const exists = savedServers.some(s => s.host === host && s.port === port);
        if (!exists) {
            savedServers.push({ name, host, port });
            localStorage.setItem('savedServers', JSON.stringify(savedServers));
            renderSavedServers();
        }
    });
    btnContainer.appendChild(saveBtn);

    // Join button - quick connect to current server
    const joinServerBtn = document.createElement('button');
    joinServerBtn.textContent = 'Join Server';
    joinServerBtn.style.flex = '1';
    joinServerBtn.style.padding = '6px';
    joinServerBtn.style.background = '#00aa00';
    joinServerBtn.style.color = '#fff';
    joinServerBtn.style.border = 'none';
    joinServerBtn.style.borderRadius = '3px';
    joinServerBtn.style.cursor = 'pointer';
    joinServerBtn.addEventListener('click', () => {
        // Start game and connect to this server
        const host = document.getElementById('menu-server-host').value || 'localhost';
        const port = parseInt(document.getElementById('menu-server-port').value, 10) || 8080;
        const playerName = document.getElementById('player-name-input').value || 'Player';
        const playerEmail = document.getElementById('player-email-input').value || '';
        localStorage.setItem('playerName', playerName);
        localStorage.setItem('playerEmail', playerEmail);
        localStorage.setItem('serverHost', host);
        localStorage.setItem('serverPort', port);
        document.body.removeChild(menu);
        const game = new Game('default', false, 'red', playerName);
        window._game = game;
        game.connectServer(host, port);
    });
    btnContainer.appendChild(joinServerBtn);

    savedRow.appendChild(btnContainer);

    settingsContainer.appendChild(savedRow);

    // (music removed from menu)

    // World type selection title
    const worldTypeTitle = document.createElement('h3');
    worldTypeTitle.textContent = 'Select World Type';
    worldTypeTitle.style.color = '#fff';
    worldTypeTitle.style.marginTop = '20px';
    settingsContainer.appendChild(worldTypeTitle);

    // World buttons
    settingsContainer.appendChild(makeButton('Default', 'default'));
    settingsContainer.appendChild(makeButton('Flat', 'flat'));
    settingsContainer.appendChild(makeButton('Islands', 'islands'));
    settingsContainer.appendChild(makeButton('Fortress', 'fortress'));

    // Load World button
    const loadBtn = document.createElement('button');
    loadBtn.textContent = 'Load World';
    loadBtn.style.width = '200px';
    loadBtn.style.margin = '8px auto';
    loadBtn.style.padding = '10px';
    loadBtn.style.fontSize = '14px';
    loadBtn.style.background = '#00aa00';
    loadBtn.style.color = '#fff';
    loadBtn.style.border = 'none';
    loadBtn.style.borderRadius = '4px';
    loadBtn.style.cursor = 'pointer';
    loadBtn.style.display = 'block';
    loadBtn.addEventListener('click', () => {
        playClickSound();
        showLoadWorldMenu(menu);
    });
    settingsContainer.appendChild(loadBtn);
    
    // Back button for Play Game screen
    const backBtn = document.createElement('button');
    backBtn.textContent = 'Back';
    backBtn.style.width = '150px';
    backBtn.style.margin = '20px auto';
    backBtn.style.padding = '10px';
    backBtn.style.fontSize = '14px';
    backBtn.style.background = '#666';
    backBtn.style.color = '#fff';
    backBtn.style.border = 'none';
    backBtn.style.borderRadius = '4px';
    backBtn.style.cursor = 'pointer';
    backBtn.style.display = 'block';
    backBtn.addEventListener('click', () => {
        playClickSound();
        settingsContainer.style.display = 'none';
        mainMenuContainer.style.display = 'block';
    });
    settingsContainer.appendChild(backBtn);
    
    menu.appendChild(settingsContainer);

    // Settings-only container (for the Settings button, initially hidden)
    const settingsOnlyContainer = document.createElement('div');
    settingsOnlyContainer.id = 'settings-only-container';
    settingsOnlyContainer.style.display = 'none';
    
    const settingsTitle = document.createElement('h3');
    settingsTitle.textContent = 'Settings';
    settingsTitle.style.color = '#fff';
    settingsTitle.style.marginBottom = '20px';
    settingsOnlyContainer.appendChild(settingsTitle);
    
    // FOV Slider
    const fovRow = document.createElement('div');
    fovRow.style.margin = '20px 0';
    fovRow.style.padding = '12px';
    fovRow.style.background = 'rgba(50,50,50,0.5)';
    fovRow.style.borderRadius = '4px';
    fovRow.style.border = '1px solid #555';
    
    const fovLabel = document.createElement('label');
    fovLabel.style.color = '#fff';
    fovLabel.style.display = 'block';
    fovLabel.style.marginBottom = '8px';
    const fovValue = document.createElement('span');
    fovValue.id = 'fov-value';
    fovValue.style.color = '#4488ff';
    fovValue.style.fontWeight = 'bold';
    const savedFov = localStorage.getItem('fov') || '90';
    fovValue.textContent = savedFov;
    fovLabel.appendChild(document.createTextNode('Field of View (FOV): '));
    fovLabel.appendChild(fovValue);
    fovRow.appendChild(fovLabel);
    
    const fovSlider = document.createElement('input');
    fovSlider.type = 'range';
    fovSlider.id = 'fov-slider';
    fovSlider.min = '90';
    fovSlider.max = '120';
    fovSlider.value = savedFov;
    fovSlider.style.width = '100%';
    fovSlider.style.cursor = 'pointer';
    fovSlider.addEventListener('input', (e) => {
        fovValue.textContent = e.target.value;
        localStorage.setItem('fov', e.target.value);
        // Apply to game if running
        if (window._game && window._game.camera) {
            window._game.camera.fov = parseFloat(e.target.value);
            window._game.camera.updateProjectionMatrix();
        }
    });
    fovRow.appendChild(fovSlider);
    
    settingsOnlyContainer.appendChild(fovRow);

    // Fog settings
    const fogRow = document.createElement('div');
    fogRow.style.margin = '20px 0';
    fogRow.style.padding = '12px';
    fogRow.style.background = 'rgba(50,50,50,0.5)';
    fogRow.style.borderRadius = '4px';
    fogRow.style.border = '1px solid #555';

    const savedFogEnabled = localStorage.getItem('fogEnabled');
    const fogEnabled = savedFogEnabled === null ? true : savedFogEnabled !== 'false';
    const savedFogDensity = localStorage.getItem('fogDensity');
    const fogDensity = savedFogDensity !== null ? Math.min(Math.max(parseFloat(savedFogDensity), 0.0), 0.05) : 0.01;

    const fogHeader = document.createElement('div');
    fogHeader.style.display = 'flex';
    fogHeader.style.alignItems = 'center';
    fogHeader.style.justifyContent = 'space-between';
    fogHeader.style.marginBottom = '8px';

    const fogLabel = document.createElement('label');
    fogLabel.style.color = '#fff';
    fogLabel.appendChild(document.createTextNode('Fog Enabled'));

    const fogEnabledCheckbox = document.createElement('input');
    fogEnabledCheckbox.type = 'checkbox';
    fogEnabledCheckbox.id = 'fog-enabled-checkbox';
    fogEnabledCheckbox.checked = fogEnabled;
    fogLabel.appendChild(fogEnabledCheckbox);
    fogHeader.appendChild(fogLabel);

    const fogValue = document.createElement('span');
    fogValue.id = 'fog-distance-value';
    fogValue.style.color = '#4488ff';
    fogValue.style.fontWeight = 'bold';
    fogValue.textContent = fogDensity.toFixed(3);
    fogHeader.appendChild(fogValue);

    fogRow.appendChild(fogHeader);

    const fogSlider = document.createElement('input');
    fogSlider.type = 'range';
    fogSlider.id = 'fog-distance-slider';
    fogSlider.min = '0.0';
    fogSlider.max = '0.05';
    fogSlider.step = '0.001';
    fogSlider.value = fogDensity;
    fogSlider.style.width = '100%';
    fogSlider.style.cursor = 'pointer';

    const applyFogSettings = (enabled, densityValue) => {
        const d = Math.min(Math.max(densityValue, 0.0), 0.05);
        if (window._game && window._game.scene) {
            window._game.scene.fog = enabled ? new THREE.FogExp2(0x87CEEB, d) : null;
        }
    };

    fogEnabledCheckbox.addEventListener('change', () => {
        localStorage.setItem('fogEnabled', fogEnabledCheckbox.checked);
        applyFogSettings(fogEnabledCheckbox.checked, parseFloat(fogSlider.value));
    });

    fogSlider.addEventListener('input', (e) => {
        const d = parseFloat(e.target.value);
        fogValue.textContent = d.toFixed(3);
        localStorage.setItem('fogDensity', Math.min(Math.max(d, 0.0), 0.05));
        applyFogSettings(fogEnabledCheckbox.checked, d);
    });

    fogRow.appendChild(fogSlider);
    settingsOnlyContainer.appendChild(fogRow);
    
    const settingsInfo = document.createElement('p');
    settingsInfo.textContent = 'Adjust FOV to change your view angle.';
    settingsInfo.style.color = '#aaa';
    settingsInfo.style.margin = '20px 0';
    settingsInfo.style.fontSize = '12px';
    settingsOnlyContainer.appendChild(settingsInfo);
    
    // Back button for settings-only
    const backBtn2 = document.createElement('button');
    backBtn2.textContent = 'Back';
    backBtn2.style.width = '150px';
    backBtn2.style.margin = '20px auto';
    backBtn2.style.padding = '10px';
    backBtn2.style.fontSize = '14px';
    backBtn2.style.background = '#666';
    backBtn2.style.color = '#fff';
    backBtn2.style.border = 'none';
    backBtn2.style.borderRadius = '4px';
    backBtn2.style.cursor = 'pointer';
    backBtn2.style.display = 'block';
    backBtn2.addEventListener('click', () => {
        playClickSound();
        settingsOnlyContainer.style.display = 'none';
        mainMenuContainer.style.display = 'block';
    });
    settingsOnlyContainer.appendChild(backBtn2);
    
    menu.appendChild(settingsOnlyContainer);

    document.body.appendChild(menu);
    
    // Music credit box (separate, top-right)
    const musicCredit = document.createElement('div');
    musicCredit.id = 'music-credit';
    musicCredit.textContent = 'music by iverstim';
    musicCredit.style.position = 'fixed';
    musicCredit.style.top = '20px';
    musicCredit.style.right = '20px';
    musicCredit.style.background = 'rgba(0,0,0,0.8)';
    musicCredit.style.color = '#aa44ff';
    musicCredit.style.padding = '10px 15px';
    musicCredit.style.borderRadius = '6px';
    musicCredit.style.border = '2px solid #aa44ff';
    musicCredit.style.fontSize = '14px';
    musicCredit.style.fontStyle = 'italic';
    musicCredit.style.zIndex = '250';
    musicCredit.style.textShadow = '1px 1px 2px rgba(0,0,0,0.5)';
    document.body.appendChild(musicCredit);
    
    // Game credit box (below music credit)
    const gameCredit = document.createElement('div');
    gameCredit.id = 'game-credit';
    gameCredit.textContent = 'game code by agare';
    gameCredit.style.position = 'fixed';
    gameCredit.style.top = '80px';
    gameCredit.style.right = '20px';
    gameCredit.style.background = 'rgba(0,0,0,0.8)';
    gameCredit.style.color = '#b80d0dff';
    gameCredit.style.padding = '10px 15px';
    gameCredit.style.borderRadius = '6px';
    gameCredit.style.border = '2px solid #fc0404ff';
    gameCredit.style.fontSize = '14px';
    gameCredit.style.fontStyle = 'italic';
    gameCredit.style.zIndex = '250';
    gameCredit.style.textShadow = '1px 1px 2px rgba(0,0,0,0.5)';
    document.body.appendChild(gameCredit);
    
    console.log('Main menu created and appended to body');
    
    // Start menu animation now that menu exists
    menuAnimate();
    console.log('Menu animation started');

    // Show load world menu
    window.showLoadWorldMenu = (mainMenu) => {
        const loadMenu = document.createElement('div');
        loadMenu.style.position = 'absolute';
        loadMenu.style.top = '50%';
        loadMenu.style.left = '50%';
        loadMenu.style.transform = 'translate(-50%, -50%)';
        loadMenu.style.background = 'rgba(0,0,0,0.95)';
        loadMenu.style.padding = '24px';
        loadMenu.style.borderRadius = '8px';
        loadMenu.style.border = '2px solid #666';
        loadMenu.style.minWidth = '400px';
        loadMenu.style.maxWidth = '600px';
        loadMenu.style.maxHeight = '80vh';
        loadMenu.style.overflowY = 'auto';
        loadMenu.style.zIndex = '1000';

        const title = document.createElement('h2');
        title.textContent = 'Load World';
        title.style.color = '#fff';
        title.style.marginBottom = '16px';
        title.style.textAlign = 'center';
        loadMenu.appendChild(title);

        // Get saved worlds from localStorage
        const savedWorlds = [];
        try {
            const saveData = localStorage.getItem('voxelWorldSave');
            if (saveData) {
                const parsed = JSON.parse(saveData);
                savedWorlds.push({
                    name: 'Main Save',
                    data: parsed,
                    key: 'voxelWorldSave'
                });
            }
        } catch (e) {
            console.error('Failed to load saved worlds:', e);
        }

        if (savedWorlds.length === 0) {
            const noSaves = document.createElement('p');
            noSaves.textContent = 'No saved worlds found.';
            noSaves.style.color = '#aaa';
            noSaves.style.textAlign = 'center';
            noSaves.style.margin = '20px 0';
            loadMenu.appendChild(noSaves);
        } else {
            savedWorlds.forEach(world => {
                const worldDiv = document.createElement('div');
                worldDiv.style.background = 'rgba(255,255,255,0.05)';
                worldDiv.style.padding = '12px';
                worldDiv.style.margin = '8px 0';
                worldDiv.style.borderRadius = '6px';
                worldDiv.style.border = '1px solid #444';
                worldDiv.style.cursor = 'pointer';
                worldDiv.style.transition = 'all 0.2s';

                worldDiv.addEventListener('mouseenter', () => {
                    worldDiv.style.background = 'rgba(255,255,255,0.1)';
                    worldDiv.style.borderColor = '#888';
                });
                worldDiv.addEventListener('mouseleave', () => {
                    worldDiv.style.background = 'rgba(255,255,255,0.05)';
                    worldDiv.style.borderColor = '#444';
                });

                const nameEl = document.createElement('div');
                nameEl.textContent = world.name;
                nameEl.style.color = '#fff';
                nameEl.style.fontSize = '16px';
                nameEl.style.fontWeight = 'bold';
                nameEl.style.marginBottom = '4px';
                worldDiv.appendChild(nameEl);

                const infoEl = document.createElement('div');
                infoEl.style.color = '#aaa';
                infoEl.style.fontSize = '12px';
                const worldType = world.data.worldType || 'default';
                const posX = world.data.playerPosition?.x?.toFixed(0) || '0';
                const posY = world.data.playerPosition?.y?.toFixed(0) || '0';
                const posZ = world.data.playerPosition?.z?.toFixed(0) || '0';
                const chunkCount = Object.keys(world.data.chunks || {}).length;
                let timeStr = '';
                if (world.data.timestamp) {
                    const date = new Date(world.data.timestamp);
                    timeStr = `<br>Last saved: ${date.toLocaleString()}`;
                }
                infoEl.innerHTML = `Type: ${worldType}<br>Position: (${posX}, ${posY}, ${posZ})<br>Modified chunks: ${chunkCount}${timeStr}`;
                worldDiv.appendChild(infoEl);

                const btnContainer = document.createElement('div');
                btnContainer.style.display = 'flex';
                btnContainer.style.gap = '8px';
                btnContainer.style.marginTop = '8px';

                const loadWorldBtn = document.createElement('button');
                loadWorldBtn.textContent = 'Load';
                loadWorldBtn.style.flex = '1';
                loadWorldBtn.style.padding = '6px';
                loadWorldBtn.style.background = '#00aa00';
                loadWorldBtn.style.color = '#fff';
                loadWorldBtn.style.border = 'none';
                loadWorldBtn.style.borderRadius = '4px';
                loadWorldBtn.style.cursor = 'pointer';
                loadWorldBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    loadSavedWorld(world.key);
                    document.body.removeChild(loadMenu);
                    document.body.removeChild(mainMenu);
                });
                btnContainer.appendChild(loadWorldBtn);

                const deleteBtn = document.createElement('button');
                deleteBtn.textContent = 'Delete';
                deleteBtn.style.flex = '1';
                deleteBtn.style.padding = '6px';
                deleteBtn.style.background = '#cc0000';
                deleteBtn.style.color = '#fff';
                deleteBtn.style.border = 'none';
                deleteBtn.style.borderRadius = '4px';
                deleteBtn.style.cursor = 'pointer';
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (confirm('Are you sure you want to delete this save?')) {
                        localStorage.removeItem(world.key);
                        document.body.removeChild(loadMenu);
                        showLoadWorldMenu(mainMenu);
                    }
                });
                btnContainer.appendChild(deleteBtn);

                worldDiv.appendChild(btnContainer);
                loadMenu.appendChild(worldDiv);
            });
        }

        const backBtn = document.createElement('button');
        backBtn.textContent = 'Back';
        backBtn.style.width = '100%';
        backBtn.style.margin = '16px 0 0 0';
        backBtn.style.padding = '10px';
        backBtn.style.background = '#666';
        backBtn.style.color = '#fff';
        backBtn.style.border = 'none';
        backBtn.style.borderRadius = '4px';
        backBtn.style.cursor = 'pointer';
        backBtn.addEventListener('click', () => {
            document.body.removeChild(loadMenu);
        });
        loadMenu.appendChild(backBtn);

        document.body.appendChild(loadMenu);
    };

    // Load saved world function
    window.loadSavedWorld = (saveKey) => {
        try {
            const saveData = localStorage.getItem(saveKey);
            if (!saveData) {
                alert('Save not found!');
                return;
            }

            const data = JSON.parse(saveData);
            console.log('Loading saved world:', data);

            const playerName = document.getElementById('player-name-input')?.value || 'Player';
            localStorage.setItem('playerName', playerName);

            // Create game with saved world type and survival mode
            const survivalMode = data.survivalMode || false;
            const game = new Game(data.worldType || 'default', false, 'red', playerName, survivalMode);
            window._game = game;

            // Restore player state
            if (data.playerPosition) {
                game.player.position.set(
                    data.playerPosition.x || 0,
                    data.playerPosition.y || 70,
                    data.playerPosition.z || 0
                );
            }
            if (data.playerYaw !== undefined) game.player.yaw = data.playerYaw;
            if (data.playerPitch !== undefined) game.player.pitch = data.playerPitch;
            if (data.inventory) game.player.inventory = data.inventory;
            if (data.equipment) game.player.equipment = { tool: 0, ...data.equipment };
            if (data.selectedBlock !== undefined) game.player.selectedBlock = data.selectedBlock;
            if (data.playerHealth !== undefined) game.player.health = data.playerHealth;
            if (data.dayTime !== undefined) game.dayTime = data.dayTime;
            if (data.hotbarIndex !== undefined) game.hotbarIndex = data.hotbarIndex;

            // Restore chest storage if present
            if (data.chestStorage) {
                game.chestStorage = new Map(Object.entries(data.chestStorage).map(([key, val]) => [key, val]));
            }

            // Refresh UI after restoring player state
            game.updateInventoryUI();
            game.updateHotbar();

            // Restore chunks
            if (data.chunks) {
                for (const [key, chunkData] of Object.entries(data.chunks)) {
                    const chunk = game.world.getChunk(chunkData.cx, chunkData.cz);
                    if (chunkData.blocks) {
                        // Decompress base64 if it's a string (new format), otherwise use array (old format)
                        if (typeof chunkData.blocks === 'string') {
                            const binaryString = atob(chunkData.blocks);
                            const bytes = new Uint8Array(binaryString.length);
                            for (let i = 0; i < binaryString.length; i++) {
                                bytes[i] = binaryString.charCodeAt(i);
                            }
                            chunk.blocks = bytes;
                        } else {
                            chunk.blocks = new Uint8Array(chunkData.blocks);
                        }
                        chunk.modified = true;
                        chunk.playerModified = true;
                    }
                    // Update mesh for this chunk
                    game.updateChunkMesh(chunkData.cx, chunkData.cz);
                }
                // If using runtime torch lights, rebuild them after load; otherwise lightmaps handle it
                if (game.useRuntimeTorchLights) {
                    try { game.rebuildTorchLights(); } catch {}
                }
            }

            console.log('World loaded successfully!');
        } catch (e) {
            console.error('Failed to load world:', e);
            alert('Failed to load world: ' + e.message);
        }
    };

    // Start the game with the selected world type and multiplayer/team settings
        window.startGame = (worldType = 'default') => {
        try {
            // Read values BEFORE removing menu from DOM
            const isMultiplayer = !!document.getElementById('multiplayer-checkbox').checked;
            const teamEl = document.querySelector('input[name="team-choice"]:checked');
            const team = teamEl ? teamEl.value : 'red';
            const playerName = document.getElementById('player-name-input').value || 'Player';
            const playerEmail = document.getElementById('player-email-input').value || '';
            const playerColor = document.getElementById('player-color-picker').value || '#4488ff';
            const useServer = !!document.getElementById('server-enabled-checkbox').checked;
            const serverHost = document.getElementById('menu-server-host').value || 'localhost';
            const serverPort = parseInt(document.getElementById('menu-server-port').value, 10) || 8080;
            const survivalMode = !!document.getElementById('survival-checkbox').checked;
            
            // Save to localStorage
            localStorage.setItem('playerName', playerName);
            localStorage.setItem('playerEmail', playerEmail);
            localStorage.setItem('playerColor', playerColor);
            localStorage.setItem('serverHost', serverHost);
            localStorage.setItem('serverPort', serverPort);
            
            // Stop menu music
            if (menuMusic) {
                menuMusic.pause();
                menuMusic.currentTime = 0;
            }
            
            // Remove menu and cleanup background scene
            window.removeEventListener('resize', menuResizeHandler);
            document.body.removeChild(menu);
            
            // Remove music credit box
            const musicCredit = document.getElementById('music-credit');
            if (musicCredit) document.body.removeChild(musicCredit);
            
            // Remove game credit box
            const gameCredit = document.getElementById('game-credit');
            if (gameCredit) document.body.removeChild(gameCredit);
            
            console.log('Instantiating Game with worldType=', worldType, 'multiplayer=', isMultiplayer, 'team=', team, 'name=', playerName, 'survival=', survivalMode, 'useServer=', useServer, 'color=', playerColor);
            const game = new Game(worldType, isMultiplayer, team, playerName, survivalMode, playerColor, playerEmail);
            // Expose for UI Connect button
            window._game = game;
            
            // Auto-connect to server if enabled
            if (useServer) {
                game.connectServer(serverHost, serverPort);
            }
            
            console.log('Game instantiated successfully');
        } catch (e) {
            console.error('Failed to instantiate Game:', e);
        }
    };
});
