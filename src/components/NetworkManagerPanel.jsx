import { useState, useEffect, useCallback } from 'react';

// ──────────────────────────────────────────────────────────────────────────────
// NetworkManagerPanel
// Provides Wi-Fi scanning/connecting and Bluetooth pairing/connecting directly
// from within the Electron kiosk UI on a Raspberry Pi. Also displays the local
// IP address so the operator knows what URL to type on a phone/tablet to access
// the wireless fleet HMI.
//
// On Windows (dev environment) all OS calls gracefully return
// { ok: false, error: 'not supported on Windows' } — the panel shows an info
// notice rather than crashing.
// ──────────────────────────────────────────────────────────────────────────────

const isElectron = typeof window !== 'undefined' && window.isElectron === true;

export default function NetworkManagerPanel() {
  // ── Tab state ──────────────────────────────────────────────────────────────
  const [tab, setTab] = useState('wifi'); // 'wifi' | 'bluetooth' | 'fleet'

  // ── Wi-Fi state ───────────────────────────────────────────────────────────
  const [wifiStatus,   setWifiStatus]   = useState(null);   // { connected, ssid, ip }
  const [wifiNetworks, setWifiNetworks] = useState([]);
  const [wifiScanning, setWifiScanning] = useState(false);
  const [wifiConnecting, setWifiConnecting] = useState(''); // ssid being connected
  const [wifiError,    setWifiError]    = useState('');
  const [passwordModal, setPasswordModal] = useState(null); // { ssid, security }
  const [passwordInput, setPasswordInput] = useState('');
  const [showPassword,  setShowPassword]  = useState(false);

  // ── Bluetooth state ────────────────────────────────────────────────────────
  const [btDevices,   setBtDevices]   = useState([]);
  const [btScanning,  setBtScanning]  = useState(false);
  const [btConnecting, setBtConnecting] = useState(''); // mac being connected
  const [btError,     setBtError]     = useState('');

  // ── Fleet server info ──────────────────────────────────────────────────────
  const [localIp, setLocalIp] = useState('');

  // ── Load initial Wi-Fi status & local IP on mount ─────────────────────────
  useEffect(() => {
    if (!isElectron) return;
    window.network.getWifiStatus().then(r => { if (r.ok) setWifiStatus(r); });
    window.network.getLocalIp().then(r => { if (r.ok) setLocalIp(r.ip); });
    window.network.getPairedDevices().then(r => { if (r.ok) setBtDevices(r.devices); });
  }, []);

  // ── Wi-Fi: scan ───────────────────────────────────────────────────────────
  const handleScanWifi = useCallback(async () => {
    setWifiScanning(true);
    setWifiError('');
    try {
      const r = await window.network.scanWifi();
      if (r.ok) setWifiNetworks(r.networks);
      else      setWifiError(r.error || 'Scan failed');
    } catch (e) { setWifiError(e.message); }
    setWifiScanning(false);
  }, []);

  // ── Wi-Fi: open password modal or connect directly ────────────────────────
  const handleSelectNetwork = (net) => {
    if (net.security && net.security !== '--') {
      setPasswordModal({ ssid: net.ssid, security: net.security });
      setPasswordInput('');
    } else {
      connectWifi(net.ssid, '');
    }
  };

  const connectWifi = async (ssid, password) => {
    setPasswordModal(null);
    setWifiConnecting(ssid);
    setWifiError('');
    try {
      const r = await window.network.connectWifi({ ssid, password });
      if (r.ok) {
        const s = await window.network.getWifiStatus();
        if (s.ok) setWifiStatus(s);
        const ipR = await window.network.getLocalIp();
        if (ipR.ok) setLocalIp(ipR.ip);
      } else {
        setWifiError(r.error || 'Connection failed');
      }
    } catch (e) { setWifiError(e.message); }
    setWifiConnecting('');
  };

  // ── Wi-Fi: disconnect ─────────────────────────────────────────────────────
  const handleDisconnectWifi = async () => {
    setWifiError('');
    const r = await window.network.disconnectWifi();
    if (r.ok) {
      setWifiStatus({ connected: false, ssid: '', ip: '' });
      setLocalIp('');
    } else {
      setWifiError(r.error || 'Disconnect failed');
    }
  };

  // ── Bluetooth: scan ───────────────────────────────────────────────────────
  const handleScanBluetooth = useCallback(async () => {
    setBtScanning(true);
    setBtError('');
    try {
      const r = await window.network.scanBluetooth();
      if (r.ok) setBtDevices(r.devices);
      else      setBtError(r.error || 'Scan failed');
    } catch (e) { setBtError(e.message); }
    setBtScanning(false);
  }, []);

  // ── Bluetooth: connect ────────────────────────────────────────────────────
  const handleConnectBluetooth = async (mac) => {
    setBtConnecting(mac);
    setBtError('');
    try {
      const r = await window.network.connectBluetooth({ mac });
      if (r.ok) {
        setBtDevices(prev => prev.map(d => d.mac === mac ? { ...d, paired: true } : d));
      } else {
        setBtError(r.error || 'Connection failed');
      }
    } catch (e) { setBtError(e.message); }
    setBtConnecting('');
  };

  // ── Signal strength bar ───────────────────────────────────────────────────
  const SignalBar = ({ signal }) => {
    const bars = signal > 75 ? 4 : signal > 50 ? 3 : signal > 25 ? 2 : 1;
    return (
      <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: '2px', height: '16px' }}>
        {[1, 2, 3, 4].map(b => (
          <span key={b} style={{
            width: '4px',
            height: `${b * 4}px`,
            borderRadius: '1px',
            background: b <= bars ? '#22c55e' : '#334155',
          }} />
        ))}
      </span>
    );
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>📡 Network & Connectivity</h2>
        {localIp && (
          <div style={styles.ipBadge}>
            <span style={{ opacity: 0.6, fontSize: '11px' }}>Fleet HMI URL</span>
            <span style={styles.ipText}>http://{localIp}:8080</span>
            <span style={{ opacity: 0.5, fontSize: '10px' }}>Open this on any phone/tablet on same Wi-Fi</span>
          </div>
        )}
      </div>

      {/* Tab Bar */}
      <div style={styles.tabBar}>
        {[
          { id: 'wifi',      label: '📶 Wi-Fi' },
          { id: 'bluetooth', label: '🔵 Bluetooth' },
          { id: 'fleet',     label: '🌐 Fleet Info' },
        ].map(t => (
          <button
            key={t.id}
            style={{ ...styles.tab, ...(tab === t.id ? styles.tabActive : {}) }}
            onClick={() => setTab(t.id)}
          >{t.label}</button>
        ))}
      </div>

      {/* ── Wi-Fi Tab ─────────────────────────────────────────────────────── */}
      {tab === 'wifi' && (
        <div style={styles.tabContent}>
          {!isElectron && (
            <div style={styles.notice}>ℹ️ Wi-Fi management is available when running as the Electron kiosk app on Raspberry Pi OS.</div>
          )}

          {/* Current Connection Status */}
          {wifiStatus && (
            <div style={styles.statusCard}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '24px' }}>{wifiStatus.connected ? '✅' : '❌'}</span>
                <div>
                  <div style={styles.statusLabel}>{wifiStatus.connected ? 'Connected' : 'Not Connected'}</div>
                  {wifiStatus.ssid && <div style={styles.statusSsid}>{wifiStatus.ssid}</div>}
                  {wifiStatus.ip   && <div style={styles.statusIp}>IP: {wifiStatus.ip}</div>}
                </div>
              </div>
              {wifiStatus.connected && (
                <button style={styles.btnDanger} onClick={handleDisconnectWifi}>Disconnect</button>
              )}
            </div>
          )}

          {/* Scan Button */}
          <button
            style={{ ...styles.btnPrimary, width: '100%', marginBottom: '12px' }}
            onClick={handleScanWifi}
            disabled={wifiScanning || !isElectron}
          >
            {wifiScanning ? '⏳ Scanning...' : '🔍 Scan for Networks'}
          </button>

          {wifiError && <div style={styles.errorBanner}>{wifiError}</div>}

          {/* Network List */}
          <div style={styles.networkList}>
            {wifiNetworks.length === 0 && !wifiScanning && (
              <div style={styles.emptyState}>No networks found. Press Scan to discover Wi-Fi networks.</div>
            )}
            {wifiNetworks
              .sort((a, b) => b.signal - a.signal)
              .map(net => (
                <button
                  key={net.ssid}
                  style={{ ...styles.networkRow, ...(net.active ? styles.networkRowActive : {}) }}
                  onClick={() => !net.active && handleSelectNetwork(net)}
                  disabled={wifiConnecting === net.ssid || !isElectron}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <SignalBar signal={net.signal} />
                    <div style={{ textAlign: 'left' }}>
                      <div style={styles.networkSsid}>{net.ssid}</div>
                      <div style={styles.networkMeta}>
                        {net.security || 'Open'} · {net.signal}%
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {net.active && <span style={styles.connectedTag}>Connected</span>}
                    {wifiConnecting === net.ssid && <span style={styles.spinner}>⏳</span>}
                    {net.security && net.security !== '--' && !net.active && (
                      <span style={{ opacity: 0.5, fontSize: '14px' }}>🔒</span>
                    )}
                  </div>
                </button>
              ))
            }
          </div>
        </div>
      )}

      {/* ── Bluetooth Tab ──────────────────────────────────────────────────── */}
      {tab === 'bluetooth' && (
        <div style={styles.tabContent}>
          {!isElectron && (
            <div style={styles.notice}>ℹ️ Bluetooth management is available when running as the Electron kiosk app on Raspberry Pi OS.</div>
          )}

          <button
            style={{ ...styles.btnPrimary, width: '100%', marginBottom: '12px' }}
            onClick={handleScanBluetooth}
            disabled={btScanning || !isElectron}
          >
            {btScanning ? '⏳ Scanning (6s)...' : '🔵 Scan for Bluetooth Devices'}
          </button>

          {btError && <div style={styles.errorBanner}>{btError}</div>}

          <div style={styles.networkList}>
            {btDevices.length === 0 && !btScanning && (
              <div style={styles.emptyState}>No devices found. Press Scan to discover Bluetooth devices.</div>
            )}
            {btDevices.map(dev => (
              <div key={dev.mac} style={styles.btRow}>
                <div>
                  <div style={styles.networkSsid}>{dev.name || 'Unknown Device'}</div>
                  <div style={styles.networkMeta}>{dev.mac}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {dev.paired
                    ? <span style={styles.connectedTag}>Paired</span>
                    : (
                      <button
                        style={styles.btnSecondary}
                        onClick={() => handleConnectBluetooth(dev.mac)}
                        disabled={btConnecting === dev.mac || !isElectron}
                      >
                        {btConnecting === dev.mac ? '⏳' : 'Pair & Connect'}
                      </button>
                    )
                  }
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Fleet Info Tab ─────────────────────────────────────────────────── */}
      {tab === 'fleet' && (
        <div style={styles.tabContent}>
          <div style={styles.fleetCard}>
            <h3 style={{ margin: '0 0 12px', fontSize: '16px', color: '#e2e8f0' }}>🌐 Wireless Fleet HMI</h3>
            <p style={styles.fleetDesc}>
              When running on a Raspberry Pi, the app hosts a built-in web server on port <strong>8080</strong>.
              Any phone, tablet, or laptop on the same Wi-Fi network can access the full HMI interface.
            </p>
            {localIp ? (
              <div style={styles.fleetUrlBox}>
                <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '4px' }}>Open this URL on any device:</div>
                <div style={styles.fleetUrl}>http://{localIp}:8080</div>
              </div>
            ) : (
              <div style={styles.notice}>Connect to Wi-Fi first to see the fleet server URL.</div>
            )}
            <div style={{ marginTop: '16px' }}>
              <h4 style={{ fontSize: '13px', color: '#94a3b8', margin: '0 0 8px' }}>What remote devices can do:</h4>
              <ul style={{ margin: 0, paddingLeft: '20px', color: '#cbd5e1', fontSize: '13px', lineHeight: '2' }}>
                <li>Monitor real-time machine position & job progress</li>
                <li>Start, pause, or abort a dispensing job</li>
                <li>View the live camera feed</li>
                <li>View SPC quality charts & nozzle health</li>
                <li>Multiple devices can connect simultaneously</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* ── Wi-Fi Password Modal ───────────────────────────────────────────── */}
      {passwordModal && (
        <div style={styles.modalOverlay}>
          <div style={styles.modalBox}>
            <h3 style={styles.modalTitle}>🔒 Connect to "{passwordModal.ssid}"</h3>
            <p style={styles.modalSub}>Security: {passwordModal.security}</p>
            <div style={styles.passwordRow}>
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="Enter Wi-Fi password"
                value={passwordInput}
                onChange={e => setPasswordInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && connectWifi(passwordModal.ssid, passwordInput)}
                style={styles.passwordInput}
                autoFocus
              />
              <button style={styles.btnSecondary} onClick={() => setShowPassword(p => !p)}>
                {showPassword ? '🙈' : '👁'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
              <button style={{ ...styles.btnPrimary, flex: 1 }}
                onClick={() => connectWifi(passwordModal.ssid, passwordInput)}
                disabled={!passwordInput}
              >Connect</button>
              <button style={{ ...styles.btnDanger, flex: 1 }}
                onClick={() => setPasswordModal(null)}
              >Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = {
  container:       { display: 'flex', flexDirection: 'column', height: '100%', color: '#e2e8f0', fontSize: '14px' },
  header:          { padding: '16px 20px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '10px' },
  title:           { margin: 0, fontSize: '18px', fontWeight: 700, color: '#f1f5f9' },
  ipBadge:         { background: '#1e40af22', border: '1px solid #3b82f680', borderRadius: '8px', padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: '2px', maxWidth: '280px' },
  ipText:          { fontFamily: 'monospace', fontSize: '15px', color: '#60a5fa', fontWeight: 700 },
  tabBar:          { display: 'flex', gap: '4px', padding: '14px 20px 0' },
  tab:             { flex: 1, padding: '8px 4px', borderRadius: '8px 8px 0 0', border: '1px solid #334155', borderBottom: 'none', background: '#1e293b', color: '#94a3b8', cursor: 'pointer', fontSize: '13px', fontWeight: 600, transition: 'all .15s' },
  tabActive:       { background: '#0f172a', color: '#60a5fa', borderColor: '#475569' },
  tabContent:      { flex: 1, overflowY: 'auto', padding: '16px 20px', background: '#0f172a', border: '1px solid #334155', borderTop: 'none', borderRadius: '0 0 10px 10px', margin: '0 20px 16px' },
  notice:          { background: '#1e3a5f', border: '1px solid #2563eb55', borderRadius: '8px', padding: '12px 16px', color: '#93c5fd', fontSize: '13px', marginBottom: '14px' },
  statusCard:      { background: '#1e293b', border: '1px solid #334155', borderRadius: '10px', padding: '14px 16px', marginBottom: '14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  statusLabel:     { fontWeight: 700, fontSize: '15px' },
  statusSsid:      { color: '#60a5fa', fontSize: '14px', marginTop: '2px' },
  statusIp:        { color: '#94a3b8', fontSize: '12px', fontFamily: 'monospace' },
  networkList:     { display: 'flex', flexDirection: 'column', gap: '6px' },
  networkRow:      { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#1e293b', border: '1px solid #334155', borderRadius: '8px', padding: '10px 14px', cursor: 'pointer', transition: 'background .15s', width: '100%', textAlign: 'left' },
  networkRowActive:{ borderColor: '#22c55e55', background: '#052e16' },
  networkSsid:     { fontWeight: 600, color: '#f1f5f9', fontSize: '14px' },
  networkMeta:     { color: '#64748b', fontSize: '12px', marginTop: '2px' },
  btRow:           { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#1e293b', border: '1px solid #334155', borderRadius: '8px', padding: '10px 14px' },
  connectedTag:    { background: '#052e16', color: '#22c55e', border: '1px solid #22c55e55', borderRadius: '12px', padding: '2px 10px', fontSize: '11px', fontWeight: 700 },
  spinner:         { fontSize: '16px' },
  errorBanner:     { background: '#450a0a', border: '1px solid #dc262655', borderRadius: '8px', padding: '10px 14px', color: '#fca5a5', fontSize: '13px', marginBottom: '12px' },
  emptyState:      { color: '#475569', textAlign: 'center', padding: '24px 0', fontSize: '13px' },
  btnPrimary:      { background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: '8px', padding: '10px 18px', cursor: 'pointer', fontWeight: 600, fontSize: '13px' },
  btnSecondary:    { background: '#334155', color: '#e2e8f0', border: '1px solid #475569', borderRadius: '8px', padding: '8px 14px', cursor: 'pointer', fontSize: '13px' },
  btnDanger:       { background: '#7f1d1d', color: '#fca5a5', border: '1px solid #dc262640', borderRadius: '8px', padding: '8px 14px', cursor: 'pointer', fontSize: '13px' },
  fleetCard:       { background: '#1e293b', border: '1px solid #334155', borderRadius: '10px', padding: '20px' },
  fleetDesc:       { color: '#94a3b8', fontSize: '13px', lineHeight: '1.7', margin: '0 0 16px' },
  fleetUrlBox:     { background: '#0f172a', border: '1px solid #1d4ed880', borderRadius: '8px', padding: '14px 16px' },
  fleetUrl:        { fontFamily: 'monospace', fontSize: '18px', color: '#60a5fa', fontWeight: 700, letterSpacing: '.5px' },
  modalOverlay:    { position: 'fixed', inset: 0, background: '#00000099', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 },
  modalBox:        { background: '#1e293b', border: '1px solid #334155', borderRadius: '14px', padding: '28px', width: '360px', maxWidth: '90vw' },
  modalTitle:      { margin: '0 0 6px', fontSize: '17px', color: '#f1f5f9' },
  modalSub:        { margin: '0 0 18px', color: '#64748b', fontSize: '13px' },
  passwordRow:     { display: 'flex', gap: '8px', alignItems: 'center' },
  passwordInput:   { flex: 1, background: '#0f172a', border: '1px solid #334155', borderRadius: '8px', padding: '10px 14px', color: '#f1f5f9', fontSize: '14px', outline: 'none' },
};
