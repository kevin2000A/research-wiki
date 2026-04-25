fn main() {
    // Keep the Tauri build script explicit so frontend asset changes are
    // reliably picked up during production rebuilds.
    tauri_build::build()
}
