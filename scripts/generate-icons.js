import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import zlib from 'zlib'

const __dirname = dirname(fileURLToPath(import.meta.url))
const resourcesDir = join(__dirname, '../resources')

if (!existsSync(resourcesDir)) {
    mkdirSync(resourcesDir, { recursive: true })
}

// PNG encoder helper (creates simple PNG)
function createPNG(width, height, pixels) {
    // PNG signature
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    
    // IHDR chunk
    const ihdrData = Buffer.alloc(13)
    ihdrData.writeUInt32BE(width, 0)
    ihdrData.writeUInt32BE(height, 4)
    ihdrData.writeUInt8(8, 8)  // bit depth
    ihdrData.writeUInt8(6, 9)  // color type (RGBA)
    ihdrData.writeUInt8(0, 10) // compression
    ihdrData.writeUInt8(0, 11) // filter
    ihdrData.writeUInt8(0, 12) // interlace
    
    const ihdr = createChunk('IHDR', ihdrData)
    
    // IDAT chunk - raw image data
    const rawData = Buffer.alloc(height * (1 + width * 4))
    for (let y = 0; y < height; y++) {
        rawData[y * (1 + width * 4)] = 0 // filter byte
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4
            const outIdx = y * (1 + width * 4) + 1 + x * 4
            rawData[outIdx] = pixels[idx]     // R
            rawData[outIdx + 1] = pixels[idx + 1] // G
            rawData[outIdx + 2] = pixels[idx + 2] // B
            rawData[outIdx + 3] = pixels[idx + 3] // A
        }
    }
    
    // Compress with zlib
    const compressed = zlib.deflateSync(rawData, { level: 9 })
    const idat = createChunk('IDAT', compressed)
    
    // IEND chunk
    const iend = createChunk('IEND', Buffer.alloc(0))
    
    return Buffer.concat([signature, ihdr, idat, iend])
}

function createChunk(type, data) {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    
    const typeBuffer = Buffer.from(type)
    const crcData = Buffer.concat([typeBuffer, data])
    const crc = crc32(crcData)
    
    const crcBuffer = Buffer.alloc(4)
    crcBuffer.writeUInt32BE(crc, 0)
    
    return Buffer.concat([length, typeBuffer, data, crcBuffer])
}

// CRC32 lookup table
const crcTable = []
for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    }
    crcTable[n] = c
}

function crc32(buffer) {
    let crc = 0xffffffff
    for (let i = 0; i < buffer.length; i++) {
        crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
    }
    return (crc ^ 0xffffffff) >>> 0
}

// Generate icon with gradient ring and notification dot
function generateIcon(size) {
    const pixels = new Uint8Array(size * size * 4)
    const center = size / 2
    const outerRadius = size * 0.45
    const innerRadius = size * 0.3
    
    // Gradient colors (purple to pink)
    const color1 = { r: 102, g: 126, b: 234 } // #667eea
    const color2 = { r: 118, g: 75, b: 162 }   // #764ba2
    const color3 = { r: 240, g: 147, b: 251 }  // #f093fb
    
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = x - center
            const dy = y - center
            const dist = Math.sqrt(dx * dx + dy * dy)
            const idx = (y * size + x) * 4
            
            if (dist <= outerRadius && dist >= innerRadius) {
                // Ring gradient
                const t = (dist - innerRadius) / (outerRadius - innerRadius)
                let r, g, b
                
                if (t < 0.5) {
                    const tt = t * 2
                    r = lerp(color1.r, color2.r, tt)
                    g = lerp(color1.g, color2.g, tt)
                    b = lerp(color1.b, color2.b, tt)
                } else {
                    const tt = (t - 0.5) * 2
                    r = lerp(color2.r, color3.r, tt)
                    g = lerp(color2.g, color3.g, tt)
                    b = lerp(color2.b, color3.b, tt)
                }
                
                // Anti-aliasing
                const alpha = smoothstep(outerRadius - 2, outerRadius, dist) * 
                              smoothstep(innerRadius, innerRadius + 2, dist)
                
                pixels[idx] = r
                pixels[idx + 1] = g
                pixels[idx + 2] = b
                pixels[idx + 3] = Math.round(alpha * 255)
            } else if (dist < innerRadius) {
                // Center notification dot
                const dotRadius = innerRadius * 0.7
                if (dist <= dotRadius) {
                    // Red notification circle
                    const t = dist / dotRadius
                    const brightness = 1 - t * 0.3
                    
                    // Soft red gradient
                    const r = Math.round(255 * brightness)
                    const g = Math.round(60 * brightness)
                    const b = Math.round(60 * brightness)
                    
                    const alpha = smoothstep(dotRadius - 3, dotRadius, dist)
                    
                    pixels[idx] = r
                    pixels[idx + 1] = g
                    pixels[idx + 2] = b
                    pixels[idx + 3] = Math.round(alpha * 255)
                } else {
                    pixels[idx + 3] = 0 // transparent
                }
            } else {
                pixels[idx + 3] = 0 // transparent
            }
        }
    }
    
    return pixels
}

function lerp(a, b, t) {
    return Math.round(a + (b - a) * t)
}

function smoothstep(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)
}

// Generate tray icon (16x16) - simple bell shape
function generateTrayIcon(size) {
    const pixels = new Uint8Array(size * size * 4)
    const center = size / 2
    const radius = size * 0.4
    
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = x - center + 0.5
            const dy = y - center + 0.5
            const dist = Math.sqrt(dx * dx + dy * dy)
            const idx = (y * size + x) * 4
            
            if (dist <= radius) {
                // Bell shape
                const bellTop = size * 0.25
                const bellBottom = size * 0.75
                const ny = (y - bellTop) / (bellBottom - bellTop)
                
                let isInside = false
                if (ny >= 0 && ny <= 1) {
                    const baseWidth = size * 0.35
                    const widthAtY = baseWidth * (ny < 0.7 ? 1 : 1 + (ny - 0.7) * 2)
                    const nx = Math.abs(x - center)
                    if (nx <= widthAtY) isInside = true
                }
                
                if (isInside) {
                    const t = dist / radius
                    // Purple gradient
                    pixels[idx] = Math.round(lerp(102, 180, t))
                    pixels[idx + 1] = Math.round(lerp(126, 100, t))
                    pixels[idx + 2] = Math.round(lerp(234, 220, t))
                    pixels[idx + 3] = 255
                } else {
                    pixels[idx + 3] = 0
                }
            } else {
                pixels[idx + 3] = 0
            }
        }
    }
    
    return pixels
}

// Generate icons
console.log('Generating icons...')

// App icon (1024x1024)
const icon1024 = generateIcon(1024)
writeFileSync(join(resourcesDir, 'icon.png'), createPNG(1024, 1024, icon1024))

// Tray icon (16x16)
const trayIcon = generateTrayIcon(16)
writeFileSync(join(resourcesDir, 'tray-icon.png'), createPNG(16, 16, trayIcon))

// Also create @2x tray icon (32x32)
const trayIcon2x = generateTrayIcon(32)
writeFileSync(join(resourcesDir, 'tray-icon@2x.png'), createPNG(32, 32, trayIcon2x))

console.log('Icons generated successfully!')
console.log('Files created in resources/')
