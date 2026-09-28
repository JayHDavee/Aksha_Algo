const { app, BrowserWindow,Menu } = require("electron");
const path = require("path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Aksha",
    
  });
  
  win.setTitle("Aksha");
  Menu.setApplicationMenu(null);
const indexPath = path.join(__dirname, "resources", "frontend", "dist", "index.html");
win.loadFile(indexPath);
  win.webContents.openDevTools();
}

app.whenReady().then(createWindow);