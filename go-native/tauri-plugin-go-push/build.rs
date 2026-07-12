// register_listener is the built-in Swift-side command behind JS
// addPluginListener — it must be in the ACL like any other command.
const COMMANDS: &[&str] = &["request_push", "get_token", "set_badge", "register_listener"];

fn main() {
  tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
