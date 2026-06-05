const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

export function health() {
  return invoke("health");
}

export function migrationModules() {
  return invoke("migration_modules");
}

export function getNetworkInterfaces() {
  return invoke("get_network_interfaces");
}

export function getNetworkStatus() {
  return invoke("get_network_status");
}

export function getPeers() {
  return invoke("get_peers");
}

export function setPreferredIp(ip) {
  return invoke("set_preferred_ip", { ip });
}

export function setDiscoveryNodeIp(ip) {
  return invoke("set_discovery_node_ip", { ip });
}

export function getSettings() {
  return invoke("get_settings");
}

export function updateSetting(key, value) {
  return invoke("update_setting", { key, value });
}

export function getProfile() {
  return invoke("get_profile");
}

export function setProfile(profile) {
  return invoke("set_profile", { profile });
}

export function getHistory() {
  return invoke("get_history");
}

export function clearHistory() {
  return invoke("clear_history");
}

export function sendPing(ip, message, sound = "chime", shape = "circle") {
  return invoke("send_ping", { ip, message, sound, shape });
}

export function sendTeamChat(message) {
  return invoke("send_team_chat", { message });
}

export function sendPrivateChat(ip, message) {
  return invoke("send_private_chat", { ip, message });
}

export function openOptionsWindow() {
  return invoke("open_options_window");
}

export function openDirectChatWindow(ip, name = null) {
  return invoke("open_direct_chat_window", { ip, name });
}

export function getDirectChatContext(windowLabel) {
  return invoke("get_direct_chat_context", { windowLabel });
}

export async function onNetworkStatus(callback) {
  return listen("network-status", (event) => callback(event.payload));
}

export async function onPeersUpdated(callback) {
  return listen("peers-updated", (event) => callback(event.payload || []));
}

export async function onChatPeersUpdated(callback) {
  return listen("chat-peers-updated", (event) => callback(event.payload || []));
}

export async function onIncomingPing(callback) {
  return listen("incoming-ping", (event) => callback(event.payload));
}

export async function onIncomingTeamChat(callback) {
  return listen("incoming-team-chat", (event) => callback(event.payload));
}

export async function onIncomingPrivateChat(callback) {
  return listen("incoming-private-chat", (event) => callback(event.payload));
}

export async function onIncomingPrivateChatWindow(callback) {
  return listen("incoming-private-chat-window", (event) => callback(event.payload));
}

export async function onSettingsUpdated(callback) {
  return listen("settings-updated", (event) => callback(event.payload));
}
