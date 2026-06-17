import { useState, useEffect } from 'react';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { Card } from './components/ui/card';
import { X, Keyboard, Wifi, Cable, Save, RotateCcw } from 'lucide-react';

type InputMode = 'keyboard' | 'tcp' | 'serial';

interface Props {
  onClose: () => void;
}

export default function RfidInputSelector({ onClose }: Props) {
  const [mode, setMode] = useState<InputMode>('keyboard');
  const [tcpHost, setTcpHost] = useState('192.168.1.100');
  const [tcpPort, setTcpPort] = useState('6000');
  const [comPort, setComPort] = useState('COM3');
  const [baudRate, setBaudRate] = useState('9600');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    const eApi = (window as any).electronAPI;
    if (!eApi) { setLoading(false); return; }
    eApi.getConfig().then((cfg: any) => {
      if (cfg.inputMode) setMode(cfg.inputMode as InputMode);
      if (cfg.rfidReader?.host) setTcpHost(cfg.rfidReader.host);
      if (cfg.rfidReader?.port) setTcpPort(String(cfg.rfidReader.port));
      if (cfg.irSensor?.comPort) setComPort(cfg.irSensor.comPort);
      if (cfg.irSensor?.baudRate) setBaudRate(String(cfg.irSensor.baudRate));
      if (cfg.apiBaseUrl) setApiBaseUrl(cfg.apiBaseUrl);
      if (cfg.appVersion) setAppVersion(cfg.appVersion);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    const eApi = (window as any).electronAPI;
    if (!eApi) return;
    await eApi.saveConfig({
      rfidInputMode: mode,
      rfidReader: { host: tcpHost, port: parseInt(tcpPort, 10) || 6000 },
      irSensor: { comPort, baudRate: parseInt(baudRate, 10) || 9600 },
      apiBaseUrl: apiBaseUrl.trim() || undefined,
    });
    setSaved(true);
  };

  const modes: { id: InputMode; label: string; icon: typeof Keyboard; desc: string }[] = [
    { id: 'keyboard', label: 'Keyboard (HID Wedge)', icon: Keyboard, desc: 'Reader emulates keyboard input — works with most USB RFID readers out of the box.' },
    { id: 'tcp', label: 'TCP / Network', icon: Wifi, desc: 'Reader sends tag data over a TCP socket (e.g. UHF portal readers).' },
    { id: 'serial', label: 'Serial / COM Port', icon: Cable, desc: 'Reader connected via RS-232 or USB serial.' },
  ];

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-6">
      <Card className="w-full max-w-lg bg-white shadow-2xl">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold text-slate-900">RFID Input Settings</h2>
            <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 text-slate-500">
              <X className="w-5 h-5" />
            </button>
          </div>

          {loading ? (
            <p className="text-slate-500 text-sm">Loading…</p>
          ) : (
            <>
              {/* Mode selector */}
              <div className="space-y-2 mb-6">
                <Label className="text-sm font-semibold text-slate-700">Input Mode</Label>
                {modes.map(({ id, label, icon: Icon, desc }) => (
                  <button
                    key={id}
                    onClick={() => setMode(id)}
                    className={`w-full text-left p-3 rounded-lg border-2 transition-all ${
                      mode === id
                        ? 'border-indigo-500 bg-indigo-50'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <Icon className={`w-5 h-5 flex-shrink-0 ${mode === id ? 'text-indigo-600' : 'text-slate-400'}`} />
                      <div>
                        <div className={`text-sm font-semibold ${mode === id ? 'text-indigo-700' : 'text-slate-700'}`}>{label}</div>
                        <div className="text-xs text-slate-500 mt-0.5">{desc}</div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>

              {/* TCP settings */}
              {mode === 'tcp' && (
                <div className="grid grid-cols-3 gap-3 mb-4">
                  <div className="col-span-2">
                    <Label className="text-xs text-slate-600 mb-1 block">Reader IP Address</Label>
                    <Input value={tcpHost} onChange={e => setTcpHost(e.target.value)} placeholder="192.168.1.100" className="text-sm" />
                  </div>
                  <div>
                    <Label className="text-xs text-slate-600 mb-1 block">Port</Label>
                    <Input value={tcpPort} onChange={e => setTcpPort(e.target.value)} placeholder="6000" className="text-sm" />
                  </div>
                </div>
              )}

              {/* Serial settings */}
              {mode === 'serial' && (
                <div className="grid grid-cols-3 gap-3 mb-4">
                  <div className="col-span-2">
                    <Label className="text-xs text-slate-600 mb-1 block">COM Port</Label>
                    <Input value={comPort} onChange={e => setComPort(e.target.value)} placeholder="COM3 or /dev/ttyUSB0" className="text-sm" />
                  </div>
                  <div>
                    <Label className="text-xs text-slate-600 mb-1 block">Baud Rate</Label>
                    <Input value={baudRate} onChange={e => setBaudRate(e.target.value)} placeholder="9600" className="text-sm" />
                  </div>
                </div>
              )}

              {/* API URL */}
              <div className="mb-6">
                <Label className="text-xs text-slate-600 mb-1 block">Back Office URL (for sync)</Label>
                <Input
                  value={apiBaseUrl}
                  onChange={e => setApiBaseUrl(e.target.value)}
                  placeholder="https://your-equip-app.replit.app"
                  className="text-sm"
                />
              </div>

              {saved && (
                <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                  <div className="flex items-center gap-2 text-amber-700 text-sm font-medium">
                    <RotateCcw className="w-4 h-4" />
                    Settings saved — restart the app to apply changes.
                  </div>
                </div>
              )}

              <div className="flex gap-3">
                <Button onClick={handleSave} className="flex-1" disabled={saved}>
                  <Save className="w-4 h-4 mr-2" />
                  {saved ? 'Saved' : 'Save Settings'}
                </Button>
                <Button variant="outline" onClick={onClose}>Close</Button>
              </div>

              {appVersion && (
                <div className="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between text-xs text-slate-400">
                  <span>Equip Portal</span>
                  <span className="font-mono bg-slate-100 px-2 py-0.5 rounded">v{appVersion}</span>
                </div>
              )}
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
