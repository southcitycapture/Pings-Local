const displayNameInput = document.getElementById('display-name')
const avatarPreview = document.getElementById('avatar-preview')
const namePreview = document.getElementById('name-preview')
const soundPreview = document.getElementById('sound-preview')
const pingSoundSelect = document.getElementById('ping-sound')
const colorBtns = document.querySelectorAll('.color-btn')
const getStartedBtn = document.getElementById('get-started')

let selectedColor = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
const SOUND_NAMES = {
    chime: '✨ Chime',
    bubble: '💧 Bubble',
    tap: '👆 Tap',
    bell: '🔔 Bell',
    drop: '💎 Drop'
}

displayNameInput.addEventListener('input', () => {
    const name = displayNameInput.value.trim()
    const initial = name ? name.charAt(0).toUpperCase() : 'A'
    avatarPreview.textContent = initial
    namePreview.textContent = name || 'Your Name'
    avatarPreview.style.background = selectedColor
})

colorBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        colorBtns.forEach(b => b.classList.remove('selected'))
        btn.classList.add('selected')
        selectedColor = btn.dataset.color
        avatarPreview.style.background = selectedColor
    })
})

pingSoundSelect.addEventListener('change', () => {
    soundPreview.textContent = SOUND_NAMES[pingSoundSelect.value] || pingSoundSelect.value
})

getStartedBtn.addEventListener('click', () => {
    const name = displayNameInput.value.trim()
    
    if (!name) {
        displayNameInput.focus()
        displayNameInput.style.borderColor = '#f5576c'
        setTimeout(() => { displayNameInput.style.borderColor = '' }, 2000)
        return
    }
    
    window.api.completeOnboarding({
        displayName: name,
        avatarColor: selectedColor,
        pingSound: pingSoundSelect.value,
        status: 'online'
    })
})
