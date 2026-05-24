const { app, BrowserWindow } = require('electron');
const dgram = require('dgram');
const path = require('path');

// ─── Force LAN-only mode ──────────────────────────────────────────────────────
// Disable every Chromium background service that touches the internet.
// Without this, Electron makes internet calls for Safe Browsing, OCSP cert
// checks, component updates, crash reporting, etc. — all of which stall when
// internet is slow or offline, breaking even purely local network transfers.
app.commandLine.appendSwitch('no-proxy-server');           // No proxy lookups
app.commandLine.appendSwitch('disable-background-networking'); // No background net
app.commandLine.appendSwitch('disable-sync');              // No Chrome sync
app.commandLine.appendSwitch('disable-breakpad');          // No crash reports
app.commandLine.appendSwitch('disable-client-side-phishing-detection');
app.commandLine.appendSwitch('disable-component-update'); // No component updater
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-features', 'TranslateUI,OptimizationHints,MediaRouter,DialMediaRouteProvider,NetworkTimeServiceQuerying,CertificateTransparencyEnforcement');
app.commandLine.appendSwitch('no-pings');
app.commandLine.appendSwitch('dns-prefetch-disable');      // No DNS prefetch
// ─────────────────────────────────────────────────────────────────────────────

let mainWindow;
let discovered = false;
const UDP_PORT = 3001;
const DISCOVER_MSG = 'AIRBRIDGE_DISCOVER';
const TIMEOUT_MS = 1000; // Wait 1 second for host response

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'AirBridge',
    icon: path.join(__dirname, 'public', 'logo.png'), // Will fallback if missing
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Remove menu bar for a clean native app look
  mainWindow.removeMenu();

  mainWindow.loadURL(url);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function startDiscovery() {
  const client = dgram.createSocket('udp4');
  
  const timeoutId = setTimeout(() => {
    if (!discovered) {
      console.log('🔍 No active host found on network. Starting host server...');
      client.close();
      
      // Start local Express and WS server
      try {
        require('./server.js');
        // Load local URL
        createWindow('http://localhost:3000');
      } catch (err) {
        console.error('Error starting host server:', err);
        // Fallback: show error page or localhost anyway
        createWindow('http://localhost:3000');
      }
    }
  }, TIMEOUT_MS);

  client.on('message', (msg, rinfo) => {
    const response = msg.toString();
    if (response.startsWith('AIRBRIDGE_HOST|')) {
      discovered = true;
      clearTimeout(timeoutId);
      client.close();
      
      const hostUrl = response.split('|')[1];
      console.log(`🎉 Host found at: ${hostUrl}`);
      
      // Load host URL directly in the Electron window
      createWindow(hostUrl);
    }
  });

  client.on('error', (err) => {
    console.error('Discovery error:', err);
    clearTimeout(timeoutId);
    client.close();
    require('./server.js');
    createWindow('http://localhost:3000');
  });

  // Bind to random port and send broadcast probe
  client.bind(0, () => {
    try {
      client.setBroadcast(true);
      const message = Buffer.from(DISCOVER_MSG);
      client.send(message, 0, message.length, UDP_PORT, '255.255.255.255', (err) => {
        if (err) {
          console.error('Failed to send broadcast packet:', err);
        }
      });
    } catch (err) {
      console.error('Failed to initialize broadcast:', err);
    }
  });
}

// App lifecycle
app.whenReady().then(() => {
  startDiscovery();
  
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      startDiscovery();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
