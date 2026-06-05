# 🔔 Pings for macOS

Welcome to **Pings**! This app helps you get your colleagues' attention in the office without interrupting their flow. When you "ping" someone, a friendly red circle pulses on their screen.

## 🚀 How to Run the App

You don't need any complex software like Xcode! Just follow these simple steps:

1. **Open Terminal**: You can find it in your Applications folder or search with Spotlight (Cmd + Space).
2. **Go to the App Folder**:
   ```bash
   cd ~/Apps/Pings
   ```
3. **Start the App**:
   ```bash
   npm start
   ```

## 📦 How to Send it to Colleagues

If you want to give the app to someone else in the office:

1. **Create the Installer**:
   ```bash
   npm run package
   ```
2. **Find the File**: Look in the `dist` folder that appears in your `Pings` directory. You'll see a `.dmg` file.
3. **Share**: Just send that `.dmg` file to your colleague! They can double-click it to install Pings just like any other Mac app.

## ⚙️ Settings

- Click the **Tray Icon** (the little icon in your top menu bar) to open the Dashboard.
- In the Dashboard, you can choose if the red circle appears in the **Top Left** or **Top Right** of your screen.
- You can also toggle **Sound Effects** on or off.

---
*Built with ❤️ for the office.*
