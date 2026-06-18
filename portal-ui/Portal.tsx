import { useState, useEffect, useRef, useCallback } from "react";
import { Card } from "./components/ui/card";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { EquipLogo } from "./components/ui/equip-logo";
import {
  AlertCircle, Link2, Link2Off, Shield,
  CheckCircle, XCircle, Trash2, Settings, Wifi, WifiOff, Clock,
  Download, RefreshCw,
} from "lucide-react";
import { getCategoryIcon, AvailabilityGrid, RecentMovements } from "@portal-shared/index";
import type { RecentMovement } from "@portal-shared/index";
import {
  savePortalSession,
  getPortalSession,
  clearPortalSession,
} from "./lib/offlineDb";
import RfidInputSelector from "./RfidInputSelector";

// ── Sound engine ──────────────────────────────────────────────────────────────
function generateWavDataUri(frequencies: Array<{ freq: number; duration: number; type?: string; volume?: number; delay?: number }>): string {
  const sampleRate = 44100;
  const totalDuration = Math.max(...frequencies.map((f) => (f.delay || 0) + f.duration));
  const numSamples = Math.ceil(sampleRate * totalDuration);
  const samples = new Float32Array(numSamples);
  for (const tone of frequencies) {
    const vol = tone.volume ?? 0.5;
    const startSample = Math.floor((tone.delay || 0) * sampleRate);
    const toneSamples = Math.ceil(tone.duration * sampleRate);
    const attackSamples = Math.min(Math.floor(sampleRate * 0.015), toneSamples);
    for (let i = 0; i < toneSamples; i++) {
      const t = i / sampleRate;
      const attackEnv = i < attackSamples ? i / attackSamples : 1;
      const fadeLen = Math.floor(toneSamples * 0.25);
      const fadeOutEnv = i >= toneSamples - fadeLen ? (toneSamples - i) / fadeLen : 1;
      const envelope = attackEnv * fadeOutEnv;
      const sample = Math.sin(2 * Math.PI * tone.freq * t);
      samples[startSample + i] = (samples[startSample + i] || 0) + sample * vol * envelope;
    }
  }
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, str: string) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
  writeStr(0, "RIFF"); view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, "WAVE"); writeStr(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, "data"); view.setUint32(40, numSamples * 2, true);
  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped * 0x7fff, true);
  }
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

let _checkoutUrl: string | null = null;
let _checkinUrl: string | null = null;
let _errorUrl: string | null = null;
let _scanUrl: string | null = null;
let _removeUrl: string | null = null;

function initSounds() {
  if (_checkoutUrl) return;
  _checkoutUrl = generateWavDataUri([{ freq: 880, duration: 0.15, volume: 0.5 }, { freq: 1100, duration: 0.2, volume: 0.5, delay: 0.16 }]);
  _checkinUrl  = generateWavDataUri([{ freq: 660, duration: 0.12, volume: 0.5 }, { freq: 880, duration: 0.12, volume: 0.5, delay: 0.13 }, { freq: 1320, duration: 0.25, volume: 0.5, delay: 0.26 }]);
  _errorUrl    = generateWavDataUri([{ freq: 520, duration: 0.18, volume: 0.6 }, { freq: 260, duration: 0.35, volume: 0.6, delay: 0.2 }]);
  _scanUrl     = generateWavDataUri([{ freq: 880, duration: 0.08, volume: 0.4 }]);
  _removeUrl   = generateWavDataUri([{ freq: 440, duration: 0.06, volume: 0.35 }, { freq: 330, duration: 0.1, volume: 0.35, delay: 0.07 }]);
}

const _audioPool: HTMLAudioElement[] = [];
function playSound(url: string | null) {
  if (!url) return;
  try {
    let audio = _audioPool.find((a) => a.paused);
    if (!audio) { audio = new Audio(); _audioPool.push(audio); }
    audio.src = url;
    audio.volume = 1.0;
    audio.play().catch(() => {});
  } catch {}
}

const playCheckout = () => { initSounds(); playSound(_checkoutUrl); };
const playCheckin  = () => { initSounds(); playSound(_checkinUrl); };
const playError    = () => { initSounds(); playSound(_errorUrl); };
const playScan     = () => { initSounds(); playSound(_scanUrl); };
const playRemove   = () => { initSounds(); playSound(_removeUrl); };

// ── Types ─────────────────────────────────────────────────────────────────────
interface PortalAuth {
  token: string;
  expiresAt: string;
  armoury: { id: string; name: string };
  settings: unknown;
}

interface ScannedUser {
  id: string;
  firstName: string;
  lastName: string;
  qid: string;
}

interface TransactionItem {
  id: string;
  rfidTag: string;
  name: string;
  category: string;
  status: "available" | "checked_out" | "maintenance" | "lost";
  action: "check_out" | "check_in";
}

interface SyncStatus {
  online: boolean;
  pendingCount: number;
  lastSyncAt: string | null;
}

type PortalPhase =
  | "idle"
  | "user_scanned"
  | "committing"
  | "result_ok"
  | "result_error";


// ── Greeting ──────────────────────────────────────────────────────────────────
function getGreeting(): string {
  const hour = new Date().getHours();
  const morning = ["ata mārie", "Mōrena", "Good Morning", "Kia ora", "Tēnā koe"];
  const afternoon = ["Good Afternoon", "Pō mārie", "Kia ora", "Tēnā koe"];
  const pool = hour < 12 ? morning : afternoon;
  return pool[Math.floor(Math.random() * pool.length)];
}

const TIMEOUT_SECONDS = 15;
const RESULT_DISPLAY_SECONDS = 1;

// ── Component ─────────────────────────────────────────────────────────────────
export default function Portal() {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const [portalAuth, setPortalAuth] = useState<PortalAuth | null>(null);
  const [pairingCode, setPairingCode] = useState("");
  const [pairingError, setPairingError] = useState("");
  const [isPairing, setIsPairing] = useState(false);

  // ── Electron-specific state ──────────────────────────────────────────────────
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ online: false, pendingCount: 0, lastSyncAt: null });
  const [showSettings, setShowSettings] = useState(false);
  const [electronInputMode, setElectronInputMode] = useState<'keyboard' | 'tcp' | 'serial'>('keyboard');
  const [uiUpdatePending, setUiUpdatePending] = useState(false);

  type AppUpdateStatus =
    | { state: 'idle' }
    | { state: 'checking' }
    | { state: 'current' }
    | { state: 'available'; version: string }
    | { state: 'downloading'; percent: number }
    | { state: 'ready'; version: string; manualInstall?: boolean }
    | { state: 'error'; message: string };
  const [appUpdate, setAppUpdate] = useState<AppUpdateStatus>({ state: 'idle' });

  // ── Kiosk exit dialog state ──────────────────────────────────────────────────
  const [showExitDialog, setShowExitDialog] = useState(false);
  const [exitPin, setExitPin] = useState("");
  const [exitPinError, setExitPinError] = useState("");
  const [exitPinPending, setExitPinPending] = useState(false);
  const [hasSupervisorPin, setHasSupervisorPin] = useState(false);
  const exitPinInputRef = useRef<HTMLInputElement>(null);

  // Ref so IPC listener always calls the latest processTag without re-subscribing
  const processTagRef = useRef<((tag: string) => void) | null>(null);

  // ── Clock / greeting ────────────────────────────────────────────────────────
  const [currentTime, setCurrentTime] = useState(new Date());
  const [greeting] = useState(getGreeting);

  // ── Portal state ────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<PortalPhase>("idle");
  const [currentUser, setCurrentUser] = useState<ScannedUser | null>(null);
  const [items, setItems] = useState<TransactionItem[]>([]);
  const [resultMessage, setResultMessage] = useState("");
  const [resultType, setResultType] = useState<"checkout" | "checkin" | "mixed" | "error">("checkout");
  const [cardFlash, setCardFlash] = useState<"checkout" | "checkin" | "mixed" | "error" | null>(null);
  const [idleError, setIdleError] = useState<string | null>(null);
  const idleErrorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [recentMovements, setRecentMovements] = useState<RecentMovement[]>([]);
  const [availableCounts, setAvailableCounts] = useState<{ category: string; available: number; total: number }[]>([]);

  // ── Movements scroll ─────────────────────────────────────────────────────────
  const movementsScrollRef = useRef<HTMLDivElement>(null);
  const movementsScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevMovementsLengthRef = useRef(0);

  const scrollMovementsToTop = useCallback((smooth = true) => {
    if (movementsScrollRef.current) {
      movementsScrollRef.current.scrollTo({ top: 0, behavior: smooth ? "smooth" : "instant" });
    }
  }, []);

  useEffect(() => {
    if (recentMovements.length > prevMovementsLengthRef.current) scrollMovementsToTop(false);
    prevMovementsLengthRef.current = recentMovements.length;
  }, [recentMovements, scrollMovementsToTop]);

  const handleMovementsScroll = useCallback(() => {
    if (movementsScrollTimerRef.current) clearTimeout(movementsScrollTimerRef.current);
    movementsScrollTimerRef.current = setTimeout(() => scrollMovementsToTop(true), 10000);
  }, [scrollMovementsToTop]);

  // ── Countdown ───────────────────────────────────────────────────────────────
  const [countdown, setCountdown] = useState(TIMEOUT_SECONDS);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastScanRef = useRef<number>(0);

  // ── Keyboard buffer ─────────────────────────────────────────────────────────
  const bufferRef = useRef("");
  const bufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userInteractedRef = useRef(false);

  // ── Audio warm-up ───────────────────────────────────────────────────────────
  useEffect(() => {
    initSounds();
    const warmup = () => {
      const a = new Audio();
      a.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
      a.volume = 0.01;
      a.play().catch(() => {});
    };
    ["click", "touchstart", "keydown"].forEach((e) => document.addEventListener(e, warmup, { once: true, passive: true }));
  }, []);

  // ── Clock ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // ── Electron config + sync status subscription ───────────────────────────────
  useEffect(() => {
    const eApi = (window as any).electronAPI;
    if (!eApi) return;

    // Get input mode
    eApi.getConfig().then((cfg: any) => {
      if (cfg?.inputMode) setElectronInputMode(cfg.inputMode);
    }).catch(() => {});

    // Subscribe to sync status events from main process
    eApi.onSyncStatus((status: SyncStatus) => {
      setSyncStatus(status);
    });

    // Kiosk: main process sends this when user tries to close the window
    if (eApi.onExitRequested) {
      eApi.onExitRequested(() => {
        setShowExitDialog(true);
        setExitPin("");
        setExitPinError("");
        if (hasSupervisorPin) setTimeout(() => exitPinInputRef.current?.focus(), 50);
      });
    }

    // Local server downloaded a new UI version from Replit — flag it so we
    // can reload safely during the next idle period.
    if (eApi.onUiUpdate) {
      eApi.onUiUpdate(() => setUiUpdatePending(true));
    }

    // App binary update notifications from electron-updater
    if (eApi.onUpdateStatus) {
      eApi.onUpdateStatus((status: AppUpdateStatus) => setAppUpdate(status));
    }

    return () => {
      eApi.removeListener?.('sync-status');
      eApi.removeListener?.('request-exit');
      eApi.removeListener?.('ui-updated');
      eApi.removeListener?.('update-status');
    };
  }, []);

  // Auto-reload when a new UI version is ready and the portal is idle.
  // If we're mid-transaction, wait until the portal returns to idle.
  useEffect(() => {
    if (!uiUpdatePending || phase !== 'idle') return;
    // Brief delay so any in-flight animations finish cleanly
    const t = setTimeout(() => window.location.reload(), 4000);
    return () => clearTimeout(t);
  }, [uiUpdatePending, phase]);

  // ── IPC RFID subscription (tcp / serial modes only) ──────────────────────────
  useEffect(() => {
    const eApi = (window as any).electronAPI;
    if (!eApi) return;
    if (electronInputMode === 'keyboard') return; // keyboard handler takes over

    eApi.onRfidTag((data: { tag: string; time: number }) => {
      processTagRef.current?.(data.tag);
    });

    return () => {
      eApi.removeListener?.('rfid-tag');
    };
  }, [electronInputMode]);

  // ── Load saved auth ──────────────────────────────────────────────────────────
  useEffect(() => {
    const key = "portalAuth2";
    const saved = localStorage.getItem(key);
    if (saved) {
      try {
        const auth = JSON.parse(saved) as PortalAuth;
        if (new Date(auth.expiresAt) > new Date()) { setPortalAuth(auth); return; }
        localStorage.removeItem(key);
      } catch { localStorage.removeItem(key); }
    }
    getPortalSession().then((s) => {
      if (!s) return;
      const offlineAuth: PortalAuth = {
        token: s.portalToken,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        armoury: { id: s.armouryId, name: s.armouryName },
        settings: {},
      };
      setPortalAuth(offlineAuth);
      localStorage.setItem(key, JSON.stringify(offlineAuth));
    });
  }, []);

  // ── Countdown logic ──────────────────────────────────────────────────────────
  const stopCountdown = useCallback(() => {
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
  }, []);

  const startCountdown = useCallback(() => {
    stopCountdown();
    setCountdown(TIMEOUT_SECONDS);
    lastScanRef.current = Date.now();
    countdownRef.current = setInterval(() => {
      const elapsed = (Date.now() - lastScanRef.current) / 1000;
      const remaining = Math.max(0, TIMEOUT_SECONDS - elapsed);
      setCountdown(Math.ceil(remaining));
      if (remaining <= 0) stopCountdown();
    }, 250);
  }, [stopCountdown]);

  const resetLastScan = useCallback(() => {
    lastScanRef.current = Date.now();
    setCountdown(TIMEOUT_SECONDS);
  }, []);

  // When countdown hits 0 in user_scanned phase → commit (commitTransaction handles
  // the "nothing to check out" case by resetting to idle).
  useEffect(() => {
    if (phase === "user_scanned" && countdown === 0) commitTransaction();
  }, [countdown, phase]);

  useEffect(() => { return () => stopCountdown(); }, [stopCountdown]);

  // ── Portal fetch helper ──────────────────────────────────────────────────────
  const portalFetch = useCallback(async (url: string, options: RequestInit = {}) => {
    if (!portalAuth) throw new Error("Not authenticated");
    return fetch(url, {
      ...options,
      cache: "no-store",
      headers: { ...(options.headers || {}), Authorization: `Bearer ${portalAuth.token}`, "Content-Type": "application/json" },
    });
  }, [portalAuth]);

  // ── Recent movements + available counts ──────────────────────────────────────
  const fetchRecentMovements = useCallback(async () => {
    if (!portalAuth) return;
    try {
      const res = await portalFetch("/api/portal/recent-movements");
      if (res.ok) setRecentMovements(await res.json());
    } catch {}
  }, [portalAuth, portalFetch]);

  const fetchAvailableCounts = useCallback(async () => {
    if (!portalAuth) return;
    try {
      const res = await portalFetch("/api/portal/available-counts");
      if (res.ok) setAvailableCounts(await res.json());
    } catch {}
  }, [portalAuth, portalFetch]);

  useEffect(() => {
    if (portalAuth) { fetchRecentMovements(); fetchAvailableCounts(); }
  }, [portalAuth, fetchRecentMovements, fetchAvailableCounts]);

  // ── Background poll — 30-second interval for Electron (network is usually LAN) ──
  useEffect(() => {
    if (!portalAuth) return;
    const id = setInterval(() => {
      fetchRecentMovements();
      fetchAvailableCounts();
    }, 30000);
    return () => clearInterval(id);
  }, [portalAuth, fetchRecentMovements, fetchAvailableCounts]);

  // ── Pairing ──────────────────────────────────────────────────────────────────
  const handlePairing = async () => {
    if (!pairingCode.trim()) { setPairingError("Please enter a portal code"); return; }
    setIsPairing(true); setPairingError("");
    try {
      const res = await fetch("/api/portal/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ portalCode: pairingCode.trim().toUpperCase() }),
      });
      if (!res.ok) { const e = await res.json(); setPairingError(e.message || "Invalid code"); return; }
      const auth = await res.json() as PortalAuth;
      localStorage.setItem("portalAuth2", JSON.stringify(auth));
      setPortalAuth(auth);
      // Push the server-managed supervisor PIN into the Electron main process so
      // operators can manage the kiosk exit PIN from the back office.
      const pin = (auth.settings as any)?.supervisorPin;
      setHasSupervisorPin(!!pin);
      if ((window as any).electronAPI?.setSupervisorPin) {
        (window as any).electronAPI.setSupervisorPin(pin || '');
      }
      await savePortalSession({
        armouryId: auth.armoury.id,
        armouryName: auth.armoury.name,
        stationName: "",
        portalToken: auth.token,
        portalCode: pairingCode.trim().toUpperCase(),
        lastSynced: Date.now(),
      });
      setPairingCode("");
    } catch { setPairingError("Failed to connect. Please try again."); }
    finally { setIsPairing(false); }
  };

  const handleUnpair = async () => {
    localStorage.removeItem("portalAuth2");
    setPortalAuth(null);
    await clearPortalSession();
    resetToIdle();
  };

  // ── Scan a tag ───────────────────────────────────────────────────────────────
  const processTag = useCallback(async (tag: string) => {
    if (!portalAuth) return;
    const cleanTag = tag.trim().toUpperCase();
    if (!cleanTag) return;

    if (phase === "idle" || phase === "result_ok" || phase === "result_error") {
      try {
        const res = await portalFetch(`/api/portal/users/rfid/${encodeURIComponent(cleanTag)}`);
        if (res.ok) {
          const user = await res.json() as ScannedUser;
          playScan();
          setCurrentUser(user);
          setIdleError(null);
          if (idleErrorTimeoutRef.current) { clearTimeout(idleErrorTimeoutRef.current); idleErrorTimeoutRef.current = null; }

          let preloadedItems: TransactionItem[] = [];
          try {
            const coRes = await portalFetch(`/api/portal/users/${user.id}/checked-out`);
            if (coRes.ok) {
              const checkedOutEq = await coRes.json() as { id: string; name: string; category: string; status: string; rfidTag: string }[];
              preloadedItems = checkedOutEq.map((e) => ({
                id: e.id, rfidTag: e.rfidTag ?? "", name: e.name, category: e.category,
                status: "checked_out" as const, action: "check_in" as const,
              }));
            }
          } catch {}

          userInteractedRef.current = false;
          setItems(preloadedItems);
          setPhase("user_scanned");
          startCountdown();
          return;
        }
      } catch {}

      try {
        const res = await portalFetch(`/api/portal/equipment/rfid/${encodeURIComponent(cleanTag)}`);
        if (res.ok) {
          const eq = await res.json() as { id: string; name: string; category: string; status: string; rfidTag: string };
          if (eq.status === "checked_out") {
            try {
              const checkinRes = await fetch("/api/portal/checkin", {
                method: "POST",
                headers: { Authorization: `Bearer ${portalAuth.token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ equipmentId: eq.id }),
              });
              if (checkinRes.ok) {
                playCheckin();
                await Promise.all([fetchRecentMovements(), fetchAvailableCounts()]);
              } else { playError(); }
            } catch { playError(); }
          } else {
            playError();
            setCardFlash("error");
            setTimeout(() => setCardFlash(null), 1000);
            setIdleError("Equipment not checked out — scan your ID card to check it out.");
            if (idleErrorTimeoutRef.current) clearTimeout(idleErrorTimeoutRef.current);
            idleErrorTimeoutRef.current = setTimeout(() => setIdleError(null), 4000);
          }
          return;
        }
      } catch {}

      playError();
      return;
    }

    if (phase === "user_scanned") {
      // Already in list — check_in items (pre-loaded): immediate check-in.
      //                  check_out items (queued): toggle off.
      const existingIdx = items.findIndex((i) => i.rfidTag === cleanTag);
      if (existingIdx !== -1) {
        const existingItem = items[existingIdx];
        if (existingItem.action === "check_in") {
          try {
            const res = await portalFetch("/api/portal/checkin", {
              method: "POST",
              body: JSON.stringify({ equipmentId: existingItem.id }),
            });
            if (res.ok) {
              playCheckin();
              setItems((prev) => prev.filter((_, idx) => idx !== existingIdx));
              resetLastScan();
              await Promise.all([fetchRecentMovements(), fetchAvailableCounts()]);
            } else { playError(); }
          } catch { playError(); }
        } else {
          playRemove();
          setItems((prev) => prev.filter((_, idx) => idx !== existingIdx));
          resetLastScan();
        }
        return;
      }

      // Not in list — resolve equipment tag
      try {
        const res = await portalFetch(`/api/portal/equipment/rfid/${encodeURIComponent(cleanTag)}`);
        if (res.ok) {
          const eq = await res.json() as { id: string; name: string; category: string; status: string; rfidTag: string };
          if (eq.status === "checked_out") {
            // Already checked out — check it in immediately (appears in recent movements)
            try {
              const checkinRes = await portalFetch("/api/portal/checkin", {
                method: "POST",
                body: JSON.stringify({ equipmentId: eq.id }),
              });
              if (checkinRes.ok) {
                playCheckin();
                resetLastScan();
                await Promise.all([fetchRecentMovements(), fetchAvailableCounts()]);
              } else { playError(); }
            } catch { playError(); }
          } else {
            // Available — queue for checkout
            playScan();
            setItems((prev) => [...prev, {
              id: eq.id, rfidTag: cleanTag, name: eq.name, category: eq.category,
              status: eq.status as TransactionItem["status"], action: "check_out",
            }]);
            resetLastScan();
          }
          return;
        }
      } catch {}

      playError();
    }
  }, [phase, items, portalAuth, portalFetch, startCountdown, resetLastScan, fetchRecentMovements, fetchAvailableCounts]);

  // Keep the ref up to date so IPC listeners always call the latest version
  useEffect(() => { processTagRef.current = processTag; }, [processTag]);

  // ── Commit ───────────────────────────────────────────────────────────────────
  // Only checkout items are committed. Pre-loaded check-in items are informational
  // only — they must be explicitly scanned to be checked back in.
  const commitTransaction = useCallback(async () => {
    if (phase !== "user_scanned") return;
    stopCountdown();
    setPhase("committing");
    const checkoutItems = items.filter((i) => i.action === "check_out");
    if (checkoutItems.length === 0) { resetToIdle(); return; }
    await doCommit(currentUser, checkoutItems);
  }, [phase, items, currentUser, stopCountdown]);

  const doCommit = async (user: ScannedUser | null, txItems: TransactionItem[]) => {
    if (!portalAuth) return;
    setPhase("committing");
    stopCountdown();

    try {
      const authHeaders: Record<string, string> = {
        Authorization: `Bearer ${portalAuth.token}`,
        "Content-Type": "application/json",
      };

      const checkoutItems = txItems.filter((i) => i.action === "check_out");
      const checkinOnlyItems = txItems.filter((i) => i.action === "check_in");
      const needReassign = checkoutItems.filter((i) => i.status === "checked_out");
      const directCheckout = checkoutItems.filter((i) => i.status !== "checked_out");

      for (const item of needReassign) {
        await fetch("/api/portal/checkin", {
          method: "POST", headers: authHeaders,
          body: JSON.stringify({ equipmentId: item.id }),
        });
      }
      for (const item of checkinOnlyItems) {
        await fetch("/api/portal/checkin", {
          method: "POST", headers: authHeaders,
          body: JSON.stringify({ equipmentId: item.id }),
        });
      }
      if (checkoutItems.length > 0 && user) {
        for (const item of [...needReassign, ...directCheckout]) {
          await fetch("/api/portal/checkout", {
            method: "POST", headers: authHeaders,
            body: JSON.stringify({ equipmentId: item.id, userId: user.id }),
          });
        }
      }

      const totalCheckedOut = checkoutItems.length;
      const totalCheckedIn = checkinOnlyItems.length;
      let rType: "checkout" | "checkin" | "mixed" = "checkout";
      if (totalCheckedOut > 0 && totalCheckedIn > 0) rType = "mixed";
      else if (totalCheckedIn > 0) rType = "checkin";
      else rType = "checkout";

      if (rType === "checkin") playCheckin(); else playCheckout();

      setResultType(rType);
      setResultMessage(
        rType === "mixed"
          ? `${totalCheckedOut} checked out, ${totalCheckedIn} checked in`
          : rType === "checkin"
          ? `${totalCheckedIn} item${totalCheckedIn !== 1 ? "s" : ""} checked in`
          : `${totalCheckedOut} item${totalCheckedOut !== 1 ? "s" : ""} checked out`
      );
      setPhase("result_ok");
      setCardFlash(rType);
      setTimeout(() => setCardFlash(null), 1000);
      // Transaction-triggered dual refresh — fire immediately in parallel
      fetchRecentMovements();
      fetchAvailableCounts();
      setTimeout(() => resetToIdle(), RESULT_DISPLAY_SECONDS * 1000);
    } catch {
      playError();
      setResultMessage("Transaction failed — please try again.");
      setResultType("error");
      setPhase("result_error");
      setCardFlash("error");
      setTimeout(() => setCardFlash(null), 1000);
      setTimeout(() => resetToIdle(), 1000);
    }
  };

  const resetToIdle = () => {
    stopCountdown();
    setPhase("idle");
    setCurrentUser(null);
    setItems([]);
    setResultMessage("");
    setCountdown(TIMEOUT_SECONDS);
    setIdleError(null);
    if (idleErrorTimeoutRef.current) { clearTimeout(idleErrorTimeoutRef.current); idleErrorTimeoutRef.current = null; }
  };

  // ── Supervisor exit ──────────────────────────────────────────────────────────
  const handleExitConfirm = async () => {
    const eApi = (window as any).electronAPI;
    if (!eApi?.confirmExit) return;
    setExitPinPending(true);
    setExitPinError("");
    try {
      const result = await eApi.confirmExit(exitPin);
      if (!result.success) {
        setExitPinError(result.error || "Incorrect PIN. Please try again.");
        setExitPin("");
        exitPinInputRef.current?.focus();
      }
      // On success, main process calls app.exit — no UI cleanup needed
    } catch {
      setExitPinError("Communication error. Please try again.");
    } finally {
      setExitPinPending(false);
    }
  };

  const handleExitCancel = () => {
    setShowExitDialog(false);
    setExitPin("");
    setExitPinError("");
  };

  // ── Demo input bar ───────────────────────────────────────────────────────────
  const [demoInput, setDemoInput] = useState("");

  const handleDemoScan = () => {
    const tag = demoInput.trim();
    if (!tag) return;
    setDemoInput("");
    processTag(tag);
  };

  // ── Global keyboard capture (keyboard / HID mode only) ────────────────────────
  useEffect(() => {
    if (!portalAuth) return;
    // In tcp/serial mode the IPC listener handles tags; suppress keyboard capture
    if (electronInputMode !== 'keyboard') return;

    const onKeyDown = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.tagName === "SELECT" || tgt.isContentEditable)) return;

      if (e.code === "Space" && phase === "user_scanned") {
        e.preventDefault();
        commitTransaction();
        return;
      }

      if (e.key === "Enter") {
        if (bufferTimerRef.current) { clearTimeout(bufferTimerRef.current); bufferTimerRef.current = null; }
        const tag = bufferRef.current.trim();
        bufferRef.current = "";
        if (tag) processTag(tag);
        return;
      }

      if (e.key.length === 1) {
        bufferRef.current += e.key;
        if (bufferTimerRef.current) clearTimeout(bufferTimerRef.current);
        bufferTimerRef.current = setTimeout(() => {
          const tag = bufferRef.current.trim();
          bufferRef.current = "";
          if (tag) processTag(tag);
        }, 200);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [portalAuth, phase, processTag, commitTransaction, electronInputMode]);

  // ── Derived colours ───────────────────────────────────────────────────────────
  const bgColor = "bg-slate-50";
  const flashBg =
    cardFlash === "checkout" ? "bg-green-500"
    : cardFlash === "checkin" ? "bg-blue-500"
    : cardFlash === "mixed" ? "bg-indigo-500"
    : cardFlash === "error" ? "bg-red-500"
    : "";
  const isColoured = cardFlash !== null;

  // ── Helpers ───────────────────────────────────────────────────────────────────
  const formatTime = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const formatDate = (d: Date) => d.toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const timeAgo = (ts: string) => {
    const diff = (Date.now() - new Date(ts).getTime()) / 1000;
    if (diff < 60) return `${Math.floor(diff)}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  };

  // ── Sync status helpers ───────────────────────────────────────────────────────
  const isElectron = typeof (window as any).electronAPI !== "undefined";

  // ── Pairing screen ────────────────────────────────────────────────────────────
  if (!portalAuth) {
    return (
      <div className="h-screen w-screen bg-slate-100 flex items-center justify-center">
        {showSettings && <RfidInputSelector onClose={() => setShowSettings(false)} />}

        {/* Exit overlay — accessible before pairing so operators can close the app */}
        {showExitDialog && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-8">
              <div className="text-center mb-6">
                <div className="w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4">
                  <Shield className="w-7 h-7 text-slate-600" />
                </div>
                <h2 className="text-2xl font-bold text-slate-900">{hasSupervisorPin ? "Enter PIN to exit" : "Exit Application"}</h2>
                {!hasSupervisorPin && <p className="text-slate-500 mt-2">Are you sure you want to close the portal?</p>}
              </div>
              <div className="space-y-4">
                {hasSupervisorPin && (
                  <>
                    <input
                      ref={exitPinInputRef}
                      type="password"
                      inputMode="numeric"
                      value={exitPin}
                      onChange={(e) => { setExitPin(e.target.value); setExitPinError(""); }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !exitPinPending) handleExitConfirm();
                        if (e.key === "Escape") handleExitCancel();
                      }}
                      placeholder="Enter PIN"
                      maxLength={20}
                      disabled={exitPinPending}
                      className="w-full text-center text-2xl tracking-widest font-mono border border-slate-300 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-slate-400"
                      autoComplete="off"
                    />
                    {exitPinError && (
                      <div className="flex items-center gap-2 text-red-600 text-sm">
                        <AlertCircle className="h-4 w-4 flex-shrink-0" />
                        <span>{exitPinError}</span>
                      </div>
                    )}
                  </>
                )}
                <button
                  onClick={handleExitConfirm}
                  disabled={exitPinPending || (hasSupervisorPin && !exitPin)}
                  className="w-full bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white font-semibold rounded-lg py-3 transition-colors"
                >
                  {exitPinPending ? "Verifying…" : "Confirm Exit"}
                </button>
                <button
                  onClick={handleExitCancel}
                  disabled={exitPinPending}
                  className="w-full border border-slate-200 hover:bg-slate-50 text-slate-700 font-medium rounded-lg py-3 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        <Card className="w-full max-w-md p-8 mx-4">
          <div className="text-center mb-8">
            <div className="flex justify-center mb-4"><EquipLogo size="lg" /></div>
            <h1 className="text-2xl font-bold text-slate-900">Portal 2.0 Setup</h1>
            <p className="text-slate-600 mt-2">Enter the portal code from your armoury settings to connect this device.</p>
          </div>
          <div className="space-y-4">
            <div>
              <Label htmlFor="p2-code">Portal Code</Label>
              <Input
                id="p2-code"
                value={pairingCode}
                onChange={(e) => setPairingCode(e.target.value.toUpperCase())}
                placeholder="8-character code"
                maxLength={8}
                className="text-center text-2xl tracking-widest font-mono mt-1"
                onKeyDown={(e) => e.key === "Enter" && handlePairing()}
              />
            </div>
            {pairingError && (
              <div className="flex items-center gap-2 text-red-600 text-sm">
                <AlertCircle className="h-4 w-4" /><span>{pairingError}</span>
              </div>
            )}
            <Button onClick={handlePairing} disabled={isPairing} className="w-full">
              <Link2 className="h-4 w-4 mr-2" />
              {isPairing ? "Connecting…" : "Connect Portal"}
            </Button>
            {isElectron && (
              <Button variant="outline" onClick={() => setShowSettings(true)} className="w-full">
                <Settings className="h-4 w-4 mr-2" />
                RFID Input Settings
              </Button>
            )}
            {isElectron && (
              <Button variant="outline" onClick={() => {
                setShowExitDialog(true);
                setExitPin("");
                setExitPinError("");
              }} className="w-full text-slate-500">
                <XCircle className="h-4 w-4 mr-2" />
                Exit Application
              </Button>
            )}
          </div>
          <p className="text-xs text-slate-500 text-center mt-6">
            Portal codes are configured in the back office under Locations › Armoury Settings.
          </p>
        </Card>
      </div>
    );
  }

  // ── Main portal UI ────────────────────────────────────────────────────────────
  const normalCardClass = "bg-white shadow-sm border border-slate-200 h-full overflow-hidden";
  const cardClass = `h-full overflow-hidden transition-all duration-200 ${isColoured ? `${flashBg} border-0 shadow-lg` : "bg-white shadow-sm border border-slate-200"}`;

  return (
    <div className={`portal2 h-screen w-screen overflow-hidden ${bgColor} flex flex-col transition-colors duration-300`}>
      {showSettings && <RfidInputSelector onClose={() => setShowSettings(false)} />}

      {/* ── Supervisor exit overlay ── */}
      {showExitDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-8">
            <div className="text-center mb-6">
              <div className="w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4">
                <Shield className="w-7 h-7 text-slate-600" />
              </div>
              <h2 className="text-2xl font-bold text-slate-900">{hasSupervisorPin ? "Enter PIN to exit" : "Exit Application"}</h2>
              {!hasSupervisorPin && <p className="text-slate-500 mt-2">Are you sure you want to close the portal?</p>}
            </div>
            <div className="space-y-4">
              {hasSupervisorPin && (
                <>
                  <input
                    ref={exitPinInputRef}
                    type="password"
                    inputMode="numeric"
                    value={exitPin}
                    onChange={(e) => { setExitPin(e.target.value); setExitPinError(""); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !exitPinPending) handleExitConfirm();
                      if (e.key === "Escape") handleExitCancel();
                    }}
                    placeholder="Enter PIN"
                    maxLength={20}
                    disabled={exitPinPending}
                    className="w-full text-center text-2xl tracking-widest font-mono border border-slate-300 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-slate-400"
                    autoComplete="off"
                  />
                  {exitPinError && (
                    <div className="flex items-center gap-2 text-red-600 text-sm">
                      <AlertCircle className="h-4 w-4 flex-shrink-0" />
                      <span>{exitPinError}</span>
                    </div>
                  )}
                </>
              )}
              <button
                onClick={handleExitConfirm}
                disabled={exitPinPending || (hasSupervisorPin && !exitPin)}
                className="w-full bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white font-semibold rounded-lg py-3 transition-colors"
              >
                {exitPinPending ? "Verifying…" : "Confirm Exit"}
              </button>
              <button
                onClick={handleExitCancel}
                disabled={exitPinPending}
                className="w-full border border-slate-200 hover:bg-slate-50 text-slate-700 font-medium rounded-lg py-3 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <div className="flex items-center justify-between px-4 py-2 flex-shrink-0">
        <div className="flex items-center space-x-2">
          <EquipLogo size="sm" />
          <span className="text-xs font-semibold px-2 py-0.5 rounded bg-indigo-100 text-indigo-700">2.0</span>
        </div>

        <div className="text-center">
          <div className="text-lg font-bold text-slate-900">{formatTime(currentTime)}</div>
          <div className="text-xs text-slate-500">{formatDate(currentTime)}</div>
        </div>

        <div className="flex items-center gap-2">
          {/* Sync status badge — Electron only */}
          {isElectron && (
            <div className="flex flex-col items-end gap-0.5">
              <div className={`flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${syncStatus.online ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-600"}`}>
                {syncStatus.online ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                {syncStatus.online ? "Online" : "Offline"}
                {syncStatus.pendingCount > 0 && <span className="ml-1 bg-amber-400 text-white rounded-full px-1 text-[10px]">{syncStatus.pendingCount}</span>}
              </div>
              {syncStatus.lastSyncAt && (
                <div className="flex items-center gap-0.5 text-[10px] text-slate-400">
                  <Clock className="w-2.5 h-2.5" />
                  <span>Synced {timeAgo(syncStatus.lastSyncAt)}</span>
                </div>
              )}
              {/* Show when a new UI version is ready but we're mid-transaction */}
              {uiUpdatePending && phase !== 'idle' && (
                <div className="flex items-center gap-0.5 text-[10px] text-indigo-500 font-medium mt-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
                  <span>Update ready</span>
                </div>
              )}
            </div>
          )}

          <div className="text-right">
            <div className="text-sm font-semibold text-slate-700">{portalAuth.armoury.name}</div>
            <div className="flex items-center gap-1 justify-end">
              <Button variant="ghost" size="sm" onClick={handleUnpair} className="text-xs h-6 px-2">
                <Link2Off className="h-3 w-3 mr-1" />Unpair
              </Button>
              {isElectron && (
                <Button variant="ghost" size="sm" onClick={() => setShowSettings(true)} className="text-xs h-6 px-2">
                  <Settings className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── App update banner ── */}
      {isElectron && appUpdate.state !== 'idle' && appUpdate.state !== 'current' && (
        <div className={`flex items-center gap-3 px-4 py-2 flex-shrink-0 text-sm font-medium ${
          appUpdate.state === 'ready' ? 'bg-emerald-600 text-white'
          : appUpdate.state === 'error' ? 'bg-red-600 text-white'
          : 'bg-indigo-600 text-white'
        }`}>
          {appUpdate.state === 'checking' && (
            <>
              <RefreshCw className="w-4 h-4 flex-shrink-0 animate-spin" />
              <span>Checking for updates…</span>
            </>
          )}
          {appUpdate.state === 'available' && (
            <>
              <Download className="w-4 h-4 flex-shrink-0 animate-bounce" />
              <span>Downloading update v{(appUpdate as any).version}…</span>
            </>
          )}
          {appUpdate.state === 'downloading' && (
            <>
              <Download className="w-4 h-4 flex-shrink-0 animate-bounce" />
              <span>Downloading update… {(appUpdate as any).percent}%</span>
              <div className="flex-1 max-w-48 h-1.5 bg-white/30 rounded-full overflow-hidden">
                <div
                  className="h-full bg-white rounded-full transition-all duration-300"
                  style={{ width: `${(appUpdate as any).percent}%` }}
                />
              </div>
            </>
          )}
          {appUpdate.state === 'ready' && (
            <>
              <CheckCircle className="w-4 h-4 flex-shrink-0" />
              <span>
                {(appUpdate as any).manualInstall
                  ? `Update v${(appUpdate as any).version} available`
                  : `Update v${(appUpdate as any).version} downloaded — restart to install`}
              </span>
              <button
                onClick={() => (window as any).electronAPI?.installUpdate?.()}
                className="ml-auto flex items-center gap-1.5 bg-white text-emerald-700 font-semibold text-xs px-3 py-1 rounded-full hover:bg-emerald-50 transition-colors"
              >
                {(appUpdate as any).manualInstall ? (
                  <><Download className="w-3 h-3" />Download DMG</>
                ) : (
                  <><RefreshCw className="w-3 h-3" />Restart Now</>
                )}
              </button>
            </>
          )}
          {appUpdate.state === 'error' && (
            <>
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>Update check failed: {(appUpdate as any).message}</span>
              <button
                onClick={() => setAppUpdate({ state: 'idle' })}
                className="ml-auto text-white/70 hover:text-white text-xs underline"
              >
                Dismiss
              </button>
            </>
          )}
        </div>
      )}

      {/* ── Body ── */}
      <div className="flex-1 overflow-hidden" style={{ display: "grid", gridTemplateColumns: "3fr 1fr", gap: "0.75rem", padding: "0 1rem 1rem", minHeight: 0 }}>

        {/* Main (3/4) */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", overflow: "hidden", height: "100%" }}>

          {/* Top row */}
          <div className="grid grid-cols-4 gap-3 flex-shrink-0" style={{ height: "calc(30vh - 2rem)" }}>

            {/* Greeting / status */}
            <div className="col-span-3">
              <Card className={normalCardClass}>
                <div className="p-4 h-full flex flex-col justify-between">
                  <div>
                    {phase === "idle" && !idleError && (
                      <>
                        <h1 className="text-4xl md:text-5xl font-bold leading-tight text-slate-900">{greeting},</h1>
                        <p className="text-xl mt-2 text-slate-500">Scan your ID card to begin.</p>
                      </>
                    )}
                    {phase === "idle" && idleError && (
                      <>
                        <div className="flex items-center gap-3 mb-2">
                          <XCircle className="h-10 w-10 text-red-500 flex-shrink-0" />
                          <h1 className="text-4xl md:text-5xl font-bold text-red-700">Not Checked Out</h1>
                        </div>
                        <p className="text-xl text-red-600 mt-1">{idleError}</p>
                      </>
                    )}
                    {phase === "user_scanned" && currentUser && (
                      <>
                        <h1 className="text-4xl md:text-5xl font-bold text-slate-900 leading-tight">{greeting},<br />{currentUser.firstName} {currentUser.lastName}</h1>
                        <p className="text-slate-500 text-xl mt-2">QID: {currentUser.qid}</p>
                        <p className="text-slate-600 text-lg mt-2">Scan equipment to add or remove items from this transaction.</p>
                      </>
                    )}
                    {phase === "committing" && (
                      <h1 className="text-4xl md:text-5xl font-bold text-slate-700">Processing…</h1>
                    )}
                    {phase === "result_ok" && (() => {
                      const c = resultType === "checkin" ? { icon: "text-blue-500", h1: "text-blue-700", sub: "text-blue-600" }
                        : resultType === "mixed" ? { icon: "text-indigo-500", h1: "text-indigo-700", sub: "text-indigo-600" }
                        : { icon: "text-green-500", h1: "text-green-700", sub: "text-green-600" };
                      return (
                        <>
                          <div className="flex items-center gap-3 mb-2">
                            <CheckCircle className={`h-10 w-10 flex-shrink-0 ${c.icon}`} />
                            <h1 className={`text-4xl md:text-5xl font-bold ${c.h1}`}>
                              {resultType === "checkout" ? "Checked Out" : resultType === "checkin" ? "Checked In" : "Transaction Complete"}
                            </h1>
                          </div>
                          {currentUser && <p className={`text-xl mt-1 ${c.sub}`}>{currentUser.firstName} {currentUser.lastName} · {currentUser.qid}</p>}
                          <p className={`text-lg mt-1 ${c.sub}`}>{resultMessage}</p>
                        </>
                      );
                    })()}
                    {phase === "result_error" && (
                      <>
                        <div className="flex items-center gap-3 mb-2">
                          <XCircle className="h-10 w-10 text-red-500 flex-shrink-0" />
                          <h1 className="text-4xl md:text-5xl font-bold text-red-700">Error</h1>
                        </div>
                        <p className="text-xl text-red-600 mt-1">{resultMessage}</p>
                      </>
                    )}
                  </div>
                  {phase === "user_scanned" && (
                    <div className="mt-2">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-slate-500">Auto-commit in</span>
                        <span className={`text-sm font-bold ${countdown <= 5 ? "text-red-500" : "text-slate-700"}`}>{countdown}s</span>
                      </div>
                      <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full transition-all ${countdown <= 5 ? "bg-red-400" : "bg-indigo-400"}`} style={{ width: `${(countdown / TIMEOUT_SECONDS) * 100}%` }} />
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            </div>

            {/* Item count */}
            <div className="col-span-1">
              <Card className={normalCardClass}>
                <div className="h-full flex flex-col items-center justify-center p-4 text-center">
                  {(() => {
                    const nc =
                      phase === "result_ok" && resultType === "checkin" ? { num: "text-blue-700", lbl: "text-blue-500" }
                      : phase === "result_ok" && resultType === "mixed" ? { num: "text-indigo-700", lbl: "text-indigo-500" }
                      : phase === "result_ok" ? { num: "text-green-700", lbl: "text-green-500" }
                      : phase === "result_error" ? { num: "text-red-700", lbl: "text-red-500" }
                      : { num: "text-slate-900", lbl: "text-slate-500" };
                    return (
                      <>
                        <div className={`font-bold leading-none ${nc.num}`} style={{ fontSize: "min(9rem, 15vh)" }}>{items.length}</div>
                        <div className={`text-xl font-medium mt-3 ${nc.lbl}`}>
                          {phase === "result_ok"
                            ? resultType === "checkout" ? "Checked Out" : resultType === "checkin" ? "Checked In" : "Processed"
                            : items.length === 1 ? "Item" : "Items"}
                        </div>
                      </>
                    );
                  })()}
                </div>
              </Card>
            </div>
          </div>

          {/* Transaction items */}
          <div className="flex-1 overflow-hidden">
            <Card className={cardClass + " h-full"}>
              <div className="p-4 h-full flex flex-col overflow-hidden">
                <div className="flex items-center justify-between mb-3 flex-shrink-0">
                  <h3 className={`text-3xl font-bold ${isColoured ? "text-white" : "text-slate-900"}`}>Equipment</h3>
                  {phase === "user_scanned" && items.length > 0 && (
                    <Button onClick={commitTransaction} className="bg-slate-900 hover:bg-slate-800 text-white text-sm px-4 py-2">
                      Commit Transaction
                    </Button>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto space-y-2">
                  {items.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full py-12 text-center">
                      <div className="text-5xl mb-4">{phase === "idle" ? "🪪" : "📡"}</div>
                      <p className={`text-lg ${isColoured ? "text-white/70" : "text-slate-400"}`}>
                        {phase === "idle" ? "Waiting for ID card scan…" : phase === "user_scanned" ? "Scan equipment to add items" : ""}
                      </p>
                      {phase === "user_scanned" && (
                        <p className={`text-sm mt-1 ${isColoured ? "text-white/60" : "text-slate-400"}`}>
                          Scan the same item again to remove it · Press Space to commit early
                        </p>
                      )}
                    </div>
                  ) : (
                    items.map((item, idx) => {
                      const Icon = getCategoryIcon(item.category);
                      const isOut = item.action === "check_out";
                      const colors = isColoured
                        ? { row: "bg-white/15 border-white/30", icon: "bg-white/20 text-white", badge: "bg-white/25 text-white", name: "text-white", sub: "text-white/70" }
                        : isOut
                        ? { row: "bg-green-50 border-green-200", icon: "bg-green-100 text-green-700", badge: "bg-green-100 text-green-700", name: "text-slate-900", sub: "text-slate-500" }
                        : { row: "bg-blue-50 border-blue-200", icon: "bg-blue-100 text-blue-700", badge: "bg-blue-100 text-blue-700", name: "text-slate-900", sub: "text-slate-500" };
                      return (
                        <div key={idx} className={`flex items-center gap-3 p-3 rounded-lg border ${colors.row}`}>
                          <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${colors.icon}`}>
                            <Icon className="w-4 h-4" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className={`font-medium text-sm truncate ${colors.name}`}>{item.name}</div>
                            <div className={`text-xs truncate ${colors.sub}`}>{item.rfidTag} · {item.category.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}</div>
                          </div>
                          <div className={`text-xs font-semibold px-2 py-0.5 rounded ${colors.badge}`}>{isOut ? "CHECK OUT" : "CHECK IN"}</div>
                          {phase === "user_scanned" && (
                            <button
                              onClick={() => { playRemove(); setItems((prev) => prev.filter((_, i) => i !== idx)); resetLastScan(); }}
                              className={`ml-1 p-1 rounded hover:bg-black/10 ${isColoured ? "text-white/70 hover:text-white" : "text-slate-400 hover:text-slate-600"}`}
                              title="Remove item"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Demo scan bar — available in dev / non-kiosk mode */}
                {typeof (window as any).electronAPI === "undefined" && (
                  <div className="mt-3 flex gap-2 flex-shrink-0 pt-3 border-t border-slate-200">
                    <Input
                      value={demoInput}
                      onChange={e => setDemoInput(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && handleDemoScan()}
                      placeholder="Simulate RFID scan…"
                      className="text-xs h-8"
                    />
                    <Button size="sm" onClick={handleDemoScan} className="h-8 text-xs px-3">Scan</Button>
                  </div>
                )}
              </div>
            </Card>
          </div>
        </div>

        {/* Sidebar (1/4) */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", height: "100%", overflow: "hidden" }}>

          {/* Available Equipment */}
          <div style={{ flex: `0 0 calc(30vh - 2rem)`, overflow: "hidden" }}>
            <Card className={normalCardClass} style={{ height: "100%", display: "flex", flexDirection: "column" }}>
              <AvailabilityGrid availableCounts={availableCounts} />
            </Card>
          </div>

          {/* Recent Movements */}
          <div className="flex-1 overflow-hidden">
            <Card className={normalCardClass} style={{ height: "100%", display: "flex", flexDirection: "column" }}>
              <RecentMovements
                recentMovements={recentMovements}
                scrollRef={movementsScrollRef}
                onScroll={handleMovementsScroll}
              />
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
