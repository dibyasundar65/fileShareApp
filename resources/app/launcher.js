const dgram = require('dgram');
const { exec } = require('child_process');
const path = require('path');

console.log('=================================================');
console.log('📡 AirBridge - Connecting to Local Network...');
console.log('=================================================');

const UDP_PORT = 3001;
const DISCOVER_MSG = 'AIRBRIDGE_DISCOVER';
const TIMEOUT_MS = 1200; // Wait 1.2 seconds for host responses

let discovered = false;

// Create a UDP socket for client discovery
const client = dgram.createSocket('udp4');

// Open the default browser to a URL
function openBrowser(url) {
  // Safe command execution for Windows default browser launch
  exec(`start "" "${url}"`, (err) => {
    if (err) {
      console.error(`Failed to launch browser:`, err);
    }
  });
}

// Timer to start local server if no host is found
const timeoutId = setTimeout(() => {
  if (!discovered) {
    console.log('🔍 No active host found on network. Starting host server...');
    client.close();
    
    // Start local server inline
    try {
      require('./server.js');
      // Wait 500ms for server to initialize, then launch local browser
      setTimeout(() => {
        openBrowser('http://localhost:3000');
      }, 500);
    } catch (err) {
      console.error('Error starting host server:', err);
    }
  }
}, TIMEOUT_MS);

// Listen for response from host
client.on('message', (msg, rinfo) => {
  const response = msg.toString();
  if (response.startsWith('AIRBRIDGE_HOST|')) {
    discovered = true;
    clearTimeout(timeoutId);
    client.close();
    
    const hostUrl = response.split('|')[1];
    console.log(`\n🎉 Host found on local network: ${rinfo.address}`);
    console.log(`🔗 Joining sharing hub at: ${hostUrl}`);
    console.log('=================================================');
    
    openBrowser(hostUrl);
    
    // Keep console open for 3 seconds so the user can see the status, then exit
    console.log('Browser opened. Exiting launcher...');
    setTimeout(() => {
      process.exit(0);
    }, 3000);
  }
});

client.on('error', (err) => {
  console.error('UDP Discovery error:', err);
  // Fallback to start local server
  clearTimeout(timeoutId);
  client.close();
  require('./server.js');
  setTimeout(() => openBrowser('http://localhost:3000'), 500);
});

// Bind to random port and send broadcast probe
client.bind(0, () => {
  try {
    client.setBroadcast(true);
    
    // Broadcast discover message to local subnet
    const message = Buffer.from(DISCOVER_MSG);
    client.send(message, 0, message.length, UDP_PORT, '255.255.255.255', (err) => {
      if (err) {
        console.error('Failed to send broadcast packet:', err);
      } else {
        console.log('📡 Searching for existing host on the network...');
      }
    });
  } catch (err) {
    console.error('Failed to initialize broadcast:', err);
  }
});
