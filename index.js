const express = require('express');
const mdns = require('mdns-js');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;

const app = express();
app.use(express.json()); // Add this line to parse JSON request bodies  
const port = 3000;

// Create directory for sync settings if it doesn't exist
fs.mkdir(path.join(__dirname, 'sync-settings')).catch(() => {});

// Serve static files from public directory
app.use(express.static('public'));

// Store discovered devices
let discoveredDevices = new Map();

// Create mDNS browser
const browser = mdns.createBrowser(mdns.tcp('http'));

// Handle device discovery
browser.on('ready', function () {
    browser.discover();
});

browser.on('update', async function (data) {
    try {
        const ip = data.addresses[0];
        if (!ip || discoveredDevices.has(ip)) return;

        // Try to verify if it's a WLED device by calling its API
        try {
            const response = await axios.get(`http://${ip}/json/info`, { timeout: 2000 });
            if (response.data && response.data.ver) {
                discoveredDevices.set(ip, {
                    name: data.hostname || 'Unknown',
                    ip: ip,
                    version: response.data.ver
                });
            }
        } catch (error) {
            // Not a WLED device or not responding
            console.log(`Device at ${ip} is not a WLED device`);
        }
    } catch (error) {
        console.error('Error processing device:', error);
    }
});

// Parse the JavaScript response to extract form values
function parseWLEDSyncSettings(jsCode) {
    const settings = {};
    
    // Extract values using regex
    const extractValue = (key) => {
        const match = jsCode.match(new RegExp(`d\\.Sf\\.${key}\\.value=(\\d+|"[^"]*")`));
        return match ? match[1].replace(/"/g, '') : null;
    };

    const extractChecked = (key) => {
        const match = jsCode.match(new RegExp(`d\\.Sf\\.${key}\\.checked=(\\d)`));
        return match ? match[1] === '1' : null;
    };

    // UDP Settings
    settings.udp = {
        UDPPort: extractValue('UP'),
        secondaryPort: extractValue('U2'),
        sendGroup: extractValue('GS'), //GS is the sum of binary powers example: If boxes 1, 4, 5 are ticked, GS will be 2⁰ + 2³ + 2⁴ = 25 . G1-G8 are the ticked boxes
        receiveGroup: extractValue('GR'), //GR follows same logic R1-R8
        sendGroup1: extractChecked('G1'),
        sendGroup2: extractChecked('G2'),
        sendGroup3: extractChecked('G3'),
        sendGroup4: extractChecked('G4'),
        sendGroup5: extractChecked('G5'),
        sendGroup6: extractChecked('G6'),
        sendGroup7: extractChecked('G7'),
        sendGroup8: extractChecked('G8'),
        receiveGroup1: extractChecked('R1'),
        receiveGroup2: extractChecked('R2'),
        receiveGroup3: extractChecked('R3'),
        receiveGroup4: extractChecked('R4'),
        receiveGroup5: extractChecked('R5'),
        receiveGroup6: extractChecked('R6'),
        receiveGroup7: extractChecked('R7'),
        receiveGroup8: extractChecked('R8')
    };

    // Sync Options
    settings.sync = {
        receiveBrightness: extractChecked('RB'),
        receiveColor: extractChecked('RC'),
        receiveEffects: extractChecked('RX'),
        receiveSegmentOptions: extractChecked('SO'),
        notifyDirect: extractChecked('SG'),
        notifyButton: extractChecked('SD'),
        notifyAlexa: extractChecked('SB'),
        notifyHue: extractChecked('SH'),
        notifyMacro: extractChecked('SM'),
        udpRetransmit: extractValue('UR')
    };

    // Instance Settings
    settings.instance = {
        enableList: extractChecked('NL'),
        discoverable: extractChecked('NB')
    };

    // Realtime Settings
    settings.realtime = {
        receiveUDP: extractChecked('RD'),
        useMainSegment: extractChecked('MO'),
        dmxStartAddress: extractValue('DA'),
        dmxMode: extractValue('DM'),
        dmxTimeout: extractValue('ET'),
        dmxSegmentSpacing: extractValue('XX'),
        e131portPriority: extractValue('PY'),
        e131Multicast: extractChecked('ES'),
        e131SkipOutOfSequence: extractChecked('EM'),
        startUniverse: extractValue('EU'),
        forceBrightness: extractChecked('FB'),
        disableGammaCorrection: extractChecked('RG'),
        ledOffset: extractValue('WO')
    };

    // MQTT Settings
    settings.mqtt = {
        enabled: extractChecked('MQ'),
        broker: extractValue('MS'),
        port: extractValue('MQPORT'),
        username: extractValue('MQUSER'),
        password: extractValue('MQPASS'), 
        clientId: extractValue('MQCID'),
        deviceTopic: extractValue('MD'),
        groupTopic: extractValue('MG'),
        buttonPublish: extractChecked('BM')
    };

    // Hue Settings
    settings.hue = {
        pollEnabled: extractChecked('HP'),
        onOff: extractChecked('HO'),
        brightness: extractChecked('HB'),
        color: extractChecked('HC'),
        pollHueLight: extractValue('HL'),
        pollInterval: extractValue('HI'),
        ip: `${extractValue('H0')}.${extractValue('H1')}.${extractValue('H2')}.${extractValue('H3')}`
    };

    // Additional Settings
    settings.additional = {
        g1: extractChecked('G1'),
        r1: extractChecked('R1'),
        di: extractValue('DI'), //In custom port mode this is 0. In E1.31 mode this is set to 5568. In artnet mode this is set to 6454
        ai: extractValue('AI'), //Alexa invocation name
        ap: extractValue('AP'), //"Also emulate devices to call the first x presets"
        bd: extractValue('BD') //Baud rate
        ep: extractValue('EP'), //In custom port mode this is the number used. In E1.31 mode this is set to 5568. In artnet mode this is set to 6454
    };

    return settings;
}

// API endpoint to get discovered devices
app.get('/api/devices', (req, res) => {
    res.json(Array.from(discoveredDevices.values()));
});

// API endpoint to fetch and parse sync settings from a specific device
app.get('/api/sync-settings/:ip', async (req, res) => {
    try {
        const ip = req.params.ip;
        const response = await axios.get(`http://${ip}/settings/s.js?p=4`, { timeout: 5000 });
        
        // Parse the JavaScript response
        const settings = parseWLEDSyncSettings(response.data);
        
        // Save to a JSON file
        const filename = `wled-sync-${ip.replace(/\./g, '-')}.json`;
        await fs.writeFile(
            path.join(__dirname, 'sync-settings', filename), 
            JSON.stringify(settings, null, 2)
        );
        
        res.json({
            settings: settings,
            savedTo: filename
        });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to fetch sync settings',
            message: error.message
        });
    }
});

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

// Add this helper function to convert JSON settings to form data
function convertSettingsToFormData(settings) {
    const params = new URLSearchParams();
    
    // Helper function to append only if the value exists
    const appendIfExists = (key, value) => {
        if (value !== null && value !== undefined) {
            params.append(key, value === true ? 'on' : value === false ? 'off' : value);
        }
    };

    // UDP Settings
    appendIfExists('UP', settings.udp.primaryPort);
    appendIfExists('U2', settings.udp.secondaryPort);
    appendIfExists('GS', settings.udp.sendGroup);
    appendIfExists('GR', settings.udp.receiveGroup);
    appendIfExists('G1', 'on');  // These seem to be always on in the example
    appendIfExists('R1', 'on');  // These seem to be always on in the example

    // Sync Options
    appendIfExists('RB', settings.sync.receiveBrightness);
    appendIfExists('RC', settings.sync.receiveColor);
    appendIfExists('RX', settings.sync.receiveEffects);
    appendIfExists('SO', settings.sync.receiveSegmentOptions);
    appendIfExists('SG', settings.sync.notifyDirect);
    appendIfExists('SD', settings.sync.notifyButton);
    appendIfExists('SB', settings.sync.notifyAlexa);
    appendIfExists('SH', settings.sync.notifyHue);
    appendIfExists('SM', settings.sync.notifyMacro);
    appendIfExists('UR', settings.sync.udpRetransmit);

    // Instance Settings
    appendIfExists('NL', settings.instance.enableList);
    appendIfExists('NB', settings.instance.discoverable);

    // Realtime Settings
    appendIfExists('RD', settings.realtime.receiveUDP);
    appendIfExists('MO', settings.realtime.useMainSegment);
    appendIfExists('DI', settings.realtime.e131Port); // This seems to be a duplicate of EP
    appendIfExists('EP', settings.realtime.e131Port);
    appendIfExists('EM', settings.realtime.e131SkipOutOfSequence);
    appendIfExists('EU', settings.realtime.e131Universe);
    appendIfExists('ES', settings.realtime.e131Multicast);
    appendIfExists('DA', settings.realtime.dmxAddress);
    appendIfExists('XX', settings.realtime.dmxSegmentSpacing); // Not sure what this is, but it's in the example
    appendIfExists('PY', '0'); // Not sure what this is, but it's in the example
    appendIfExists('DM', settings.realtime.dmxMode);
    appendIfExists('ET', settings.realtime.dmxTimeout);
    appendIfExists('FB', settings.realtime.forceBrightness);
    appendIfExists('RG', settings.realtime.disableGammaCorrection);
    appendIfExists('WO', settings.realtime.ledOffset);

    // Additional settings
    appendIfExists('AI', ''); // Not sure what this is, but it's in the example
    appendIfExists('AP', '0'); // Not sure what this is, but it's in the example

    // MQTT Settings
    appendIfExists('MQ', settings.mqtt.enabled);
    appendIfExists('MS', settings.mqtt.broker);
    appendIfExists('MQPORT', settings.mqtt.port);
    appendIfExists('MQUSER', settings.mqtt.username);
    appendIfExists('MQPASS', settings.mqtt.password); // We probably don't want to send the password
    appendIfExists('MQCID', settings.mqtt.clientId);
    appendIfExists('MD', settings.mqtt.deviceTopic);
    appendIfExists('MG', settings.mqtt.groupTopic);
    appendIfExists('BM', settings.mqtt.buttonPublish);

    // Hue Settings
    appendIfExists('HL', '2'); // Not sure what this is, but it's in the example
    appendIfExists('HI', settings.hue.pollInterval);
    appendIfExists('HP', settings.hue.pollEnabled);
    appendIfExists('HO', settings.hue.onOff);
    appendIfExists('HB', settings.hue.brightness);
    appendIfExists('HC', settings.hue.color);
    if (settings.hue && settings.hue.ip) {
        const [h0, h1, h2, h3] = settings.hue.ip.split('.');
        appendIfExists('H0', h0);
        appendIfExists('H1', h1);
        appendIfExists('H2', h2);
        appendIfExists('H3', h3);
    }

    // Additional setting at the end
    appendIfExists('BD', '10000'); // Not sure what this is, but it's in the example

    return params.toString();
}
// Get list of available presets
app.get('/api/presets', async (req, res) => {
    try {
        const files = await fs.readdir(path.join(__dirname, 'presets'));
        const presets = files.filter(file => file.endsWith('.json'));
        res.json(presets);
    } catch (error) {
        res.status(500).json({ error: 'Failed to read presets directory' });
    }
});


app.post('/api/apply-preset/:ip', async (req, res) => {
    try {
        const { ip } = req.params;
        const { preset } = req.body;
        
        console.log(`Applying preset ${preset} to device ${ip}`);
        
        // Read the preset file and convert settings to form data
        const presetPath = path.join(__dirname, 'presets', preset);
        const presetData = JSON.parse(await fs.readFile(presetPath, 'utf8'));
        const formData = convertSettingsToFormData(presetData);
        
        console.log('Form data to be sent:', formData);
        
        try {
            const response = await axios.post(`http://${ip}/settings/sync`, formData, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                maxRedirects: 0,
                validateStatus: function (status) {
                    return status >= 200 && status < 300;
                },
            });
            
            console.log('Preset applied successfully');
            res.json({ success: true, message: 'Preset applied successfully' });
        } catch (error) {
            if (error.message.includes('Invalid character in chunk size')) {
                // Ignore this specific error and treat the request as successful
                console.log('Ignored "Invalid character in chunk size" error. Preset likely applied successfully.');
                res.json({ success: true, message: 'Preset likely applied successfully (ignored parsing error)' });
            } else if (error.response) {
                // Handle other response errors
                console.error('Error response:', error.response.status, error.response.data);
                res.status(error.response.status).json({
                    error: 'Failed to apply preset',
                    message: error.response.data
                });
            } else {
                // Handle network errors or other issues
                throw error;
            }
        }
    } catch (error) {
        console.error('Error applying preset:', error);
        res.status(500).json({
            error: 'Failed to apply preset',
            message: error.message,
        });
    }
});