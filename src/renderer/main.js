let audioContext = null

function getAudioContext() {
    if (!audioContext || audioContext.state === 'closed') {
        audioContext = new AudioContext()
    }
    return audioContext
}

// Gentle ping sounds using Web Audio API
const SOUNDS = {
    bubble: () => playTone(880, 'sine', 0.15, 0.3),
    chime: () => playTone(1200, 'sine', 0.12, 0.4),
    tap: () => playTone(600, 'triangle', 0.08, 0.2),
    bell: () => playTone(1500, 'sine', 0.2, 0.5),
    drop: () => {
        playTone(800, 'sine', 0.1, 0.2)
        setTimeout(() => playTone(600, 'sine', 0.08, 0.15), 120)
    },
    off: () => {} // Silent
}

let selectedSound = 'chime'

function playTone(freq, type, vol, duration) {
    try {
        const ctx = getAudioContext()
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()

        osc.type = type
        osc.frequency.setValueAtTime(freq, ctx.currentTime)

        gain.gain.setValueAtTime(vol, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration)

        osc.connect(gain)
        gain.connect(ctx.destination)

        osc.start()
        osc.stop(ctx.currentTime + duration)
    } catch (e) {
        console.warn('Audio playback failed:', e)
    }
}

// Resume audio context on user interaction
document.addEventListener('click', () => {
    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume()
    }
}, { once: true })

document.addEventListener('keydown', () => {
    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume()
    }
}, { once: true })

window.api.onStartPulse((data) => {
    const shape = data.shape || 'circle'
    const messageEl = document.getElementById('ping-message')
    const circleEl = document.getElementById('ping-circle')
    const borderEl = document.getElementById('ping-border')
    
    // Hide all shapes first
    circleEl.className = 'circle'
    borderEl.classList.remove('pulse')
    
    // Show the appropriate shape
    if (shape === 'border') {
        borderEl.classList.add('pulse')
    } else {
        // Change shape based on setting
        if (shape === 'square') {
            circleEl.classList.add('square')
        } else if (shape === 'diamond') {
            circleEl.classList.add('diamond')
        }
        circleEl.classList.add('pulse')
    }

    // Show custom message if provided
    if (data.message) {
        messageEl.textContent = data.message
        messageEl.classList.add('visible')
    } else {
        messageEl.classList.remove('visible')
    }

    // Play the selected sound
    const soundFn = SOUNDS[selectedSound]
    if (soundFn) soundFn()

    setTimeout(() => {
        circleEl.className = 'circle'
        borderEl.classList.remove('pulse')
        messageEl.classList.remove('visible')
    }, 4000)
})

// Listen for sound setting changes
window.api.onSoundChanged((sound) => {
    selectedSound = sound || 'off'
    try { localStorage.setItem('ping-sound', sound) } catch { }
})

// Load saved sound preference
try {
    const saved = localStorage.getItem('ping-sound')
    if (saved && SOUNDS[saved]) selectedSound = saved
} catch { }
