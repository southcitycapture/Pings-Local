const COMMANDS: &[&str] = &["request_push", "get_token", "set_badge"];

fn main() {
  tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
