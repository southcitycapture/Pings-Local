use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct Settings {
    pub position: String,
    pub sound: String,
    pub dnd: bool,
    pub custom_message: String,
    pub ping_shape: String,
    pub preferred_ip: String,
    pub discovery_node_ip: String,
    pub peer_sounds: HashMap<String, String>,
    pub peer_aliases: HashMap<String, String>,
    pub quick_replies: Vec<String>,
    pub has_completed_onboarding: bool,
    pub effect_color: String,
    pub effect_opacity: f64,
    pub border_thickness: u32,
    pub effect_feather: u32,
    pub effect_duration_ms: u32,
    pub reduce_motion: bool,
    pub show_diagnostics: bool,
    pub chat_sounds_enabled: bool,
    pub chat_send_sound: String,
    pub chat_receive_sound: String,
    pub dark_mode: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct Profile {
    pub display_name: String,
    pub avatar_color: String,
    pub ping_sound: String,
    pub status: String,
    pub avatar: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    #[serde(rename = "type")]
    pub kind: String,
    pub peer_name: String,
    pub peer_ip: String,
    pub message: String,
    pub timestamp: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            position: "top-right".to_string(),
            sound: "chime".to_string(),
            dnd: false,
            custom_message: String::new(),
            ping_shape: "circle".to_string(),
            preferred_ip: String::new(),
            discovery_node_ip: String::new(),
            peer_sounds: HashMap::new(),
            peer_aliases: HashMap::new(),
            quick_replies: vec![
                "On my way!".to_string(),
                "Be there in 5".to_string(),
                "Thanks!".to_string(),
                "Got it".to_string(),
                "One moment".to_string(),
            ],
            has_completed_onboarding: false,
            effect_color: "#14b8a6".to_string(),
            effect_opacity: 0.9,
            border_thickness: 28,
            effect_feather: 42,
            effect_duration_ms: 1150,
            reduce_motion: false,
            show_diagnostics: false,
            chat_sounds_enabled: true,
            chat_send_sound: "tap".to_string(),
            chat_receive_sound: "bubble".to_string(),
            dark_mode: false,
        }
    }
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            display_name: String::new(),
            avatar_color: String::new(),
            ping_sound: "chime".to_string(),
            status: "online".to_string(),
            avatar: None,
        }
    }
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    fs::create_dir_all(&path).map_err(|e| format!("failed to create app data dir: {e}"))?;
    Ok(path)
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: PathBuf) -> T {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<T>(&text).ok())
        .unwrap_or_default()
}

fn write_json<T: Serialize>(path: PathBuf, value: &T) -> Result<(), String> {
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|e| format!("failed to serialize json: {e}"))?;
    fs::write(path, bytes).map_err(|e| format!("failed to write json: {e}"))
}

pub fn load_settings(app: &AppHandle) -> Result<Settings, String> {
    let dir = app_data_dir(app)?;
    Ok(read_json(dir.join("settings.json")))
}

pub fn save_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let dir = app_data_dir(app)?;
    write_json(dir.join("settings.json"), settings)
}

pub fn update_setting(app: &AppHandle, key: String, value: Value) -> Result<Settings, String> {
    let mut settings = load_settings(app)?;
    match key.as_str() {
        "position" => {
            if let Some(v) = value.as_str() {
                settings.position = v.to_string();
            }
        }
        "sound" => {
            if let Some(v) = value.as_str() {
                settings.sound = v.to_string();
            }
        }
        "dnd" => {
            if let Some(v) = value.as_bool() {
                settings.dnd = v;
            }
        }
        "customMessage" => {
            if let Some(v) = value.as_str() {
                settings.custom_message = v.to_string();
            }
        }
        "pingShape" => {
            if let Some(v) = value.as_str() {
                settings.ping_shape = v.to_string();
            }
        }
        "preferredIp" => {
            if let Some(v) = value.as_str() {
                settings.preferred_ip = v.to_string();
            }
        }
        "discoveryNodeIp" => {
            if let Some(v) = value.as_str() {
                settings.discovery_node_ip = v.to_string();
            }
        }
        "peerSounds" => {
            if let Ok(parsed) = serde_json::from_value::<HashMap<String, String>>(value.clone()) {
                settings.peer_sounds = parsed;
            }
        }
        "peerAliases" => {
            if let Ok(parsed) = serde_json::from_value::<HashMap<String, String>>(value.clone()) {
                settings.peer_aliases = parsed;
            }
        }
        "quickReplies" => {
            if let Ok(parsed) = serde_json::from_value::<Vec<String>>(value.clone()) {
                settings.quick_replies = parsed.into_iter().take(8).collect();
            }
        }
        "hasCompletedOnboarding" => {
            if let Some(v) = value.as_bool() {
                settings.has_completed_onboarding = v;
            }
        }
        "effectColor" => {
            if let Some(v) = value.as_str() {
                settings.effect_color = v.to_string();
            }
        }
        "effectOpacity" => {
            if let Some(v) = value.as_f64() {
                settings.effect_opacity = v.clamp(0.15, 1.0);
            }
        }
        "borderThickness" => {
            if let Some(v) = value.as_u64() {
                settings.border_thickness = v.clamp(4, 96) as u32;
            }
        }
        "effectFeather" => {
            if let Some(v) = value.as_u64() {
                settings.effect_feather = v.clamp(6, 96) as u32;
            }
        }
        "effectDurationMs" => {
            if let Some(v) = value.as_u64() {
                settings.effect_duration_ms = v.clamp(350, 4000) as u32;
            }
        }
        "reduceMotion" => {
            if let Some(v) = value.as_bool() {
                settings.reduce_motion = v;
            }
        }
        "showDiagnostics" => {
            if let Some(v) = value.as_bool() {
                settings.show_diagnostics = v;
            }
        }
        "chatSoundsEnabled" => {
            if let Some(v) = value.as_bool() {
                settings.chat_sounds_enabled = v;
            }
        }
        "chatSendSound" => {
            if let Some(v) = value.as_str() {
                settings.chat_send_sound = v.to_string();
            }
        }
        "chatReceiveSound" => {
            if let Some(v) = value.as_str() {
                settings.chat_receive_sound = v.to_string();
            }
        }
        "darkMode" => {
            if let Some(v) = value.as_bool() {
                settings.dark_mode = v;
            }
        }
        _ => {}
    }
    save_settings(app, &settings)?;
    Ok(settings)
}

pub fn load_profile(app: &AppHandle) -> Result<Profile, String> {
    let dir = app_data_dir(app)?;
    Ok(read_json(dir.join("profile.json")))
}

pub fn save_profile(app: &AppHandle, profile: &Profile) -> Result<(), String> {
    let dir = app_data_dir(app)?;
    write_json(dir.join("profile.json"), profile)
}

pub fn load_history(app: &AppHandle) -> Result<Vec<HistoryEntry>, String> {
    let dir = app_data_dir(app)?;
    Ok(read_json(dir.join("history.json")))
}

pub fn clear_history(app: &AppHandle) -> Result<(), String> {
    let dir = app_data_dir(app)?;
    write_json::<Vec<HistoryEntry>>(dir.join("history.json"), &Vec::new())
}
