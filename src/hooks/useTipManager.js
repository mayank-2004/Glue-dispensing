import { useState, useEffect, useCallback, useRef } from "react";

const STORAGE_KEY = "tipManager_v1";
const DEFAULT_SLOT_COUNT = 4;

export const TIP_VERIFY = {
  UNVERIFIED: "UNVERIFIED",
  VERIFIED: "VERIFIED",
  FAILED: "FAILED",
};

const SEQUENCE_STEPS = [
  { key: "safe_z",       label: "Lifting to safe Z height" },
  { key: "move_drop",    label: "Moving to drop slot" },
  { key: "lower_drop",   label: "Lowering onto drop pin" },
  { key: "release",      label: "Releasing current tip" },
  { key: "lift_drop",    label: "Lifting clear of drop slot" },
  { key: "move_pickup",  label: "Moving to pickup slot" },
  { key: "lower_pickup", label: "Lowering onto new tip" },
  { key: "seat",         label: "Seating new tip" },
  { key: "lift_pickup",  label: "Lifting with new tip" },
  { key: "apply_offset", label: "Applying tip tool offset" },
  { key: "verify",       label: "Verifying tip installation" },
];

function newTip(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    name: "New Tip",
    type: "Standard",
    slotIndex: 0,
    toolOffset: { dx: 0, dy: 0, dz: 0 },
    presenceConfirmed: false,
    lastVerified: null,
    ...overrides,
  };
}

function newSlot(index) {
  return { index, label: `Slot ${index + 1}`, position: { x: null, y: null, z: null }, tipId: null };
}

function buildSlots(count) {
  return Array.from({ length: count }, (_, i) => newSlot(i));
}

function loadState() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); }
  catch { return null; }
}

export function useTipManager() {
  const saved = loadState();

  const [tipLibrary, setTipLibrary]       = useState(() => saved?.tipLibrary ?? []);
  const [slots, setSlots]                 = useState(() => saved?.slots ?? buildSlots(DEFAULT_SLOT_COUNT));
  const [activeTipId, setActiveTipId]     = useState(() => saved?.activeTipId ?? null);
  const [verificationState, setVerificationState] = useState(() => saved?.verificationState ?? TIP_VERIFY.UNVERIFIED);

  const [sequenceRunning, setSequenceRunning] = useState(false);
  const [sequenceSteps, setSequenceSteps]     = useState(SEQUENCE_STEPS.map(s => ({ ...s, status: "pending" })));
  const [sequenceError, setSequenceError]     = useState(null);
  const [targetTipId, setTargetTipId]         = useState(null);
  const abortRef = useRef(false);

  // Persist state
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tipLibrary, slots, activeTipId, verificationState }));
  }, [tipLibrary, slots, activeTipId, verificationState]);

  // Listen for TIP_STATUS events from useSerialMachine
  useEffect(() => {
    const handler = (e) => {
      const { slotIndex, present } = e.detail;
      const slot = slots[slotIndex];
      if (!slot) return;
      const tip = tipLibrary.find(t => t.id === slot.tipId);
      if (!tip || tip.id !== activeTipId) return;
      const newState = present ? TIP_VERIFY.VERIFIED : TIP_VERIFY.FAILED;
      setVerificationState(newState);
      setTipLibrary(prev => prev.map(t =>
        t.id === tip.id ? { ...t, presenceConfirmed: present, lastVerified: new Date().toISOString() } : t
      ));
    };
    window.addEventListener("tip-status", handler);
    return () => window.removeEventListener("tip-status", handler);
  }, [slots, tipLibrary, activeTipId]);

  // Listen for TIP_CHANGE_OK / TIP_CHANGE_FAIL from embedded
  useEffect(() => {
    const ok = () => {
      setVerificationState(TIP_VERIFY.VERIFIED);
      setSequenceSteps(prev => prev.map(s => s.key === "verify" ? { ...s, status: "done" } : s));
    };
    const fail = () => {
      setVerificationState(TIP_VERIFY.FAILED);
      setSequenceSteps(prev => prev.map(s => s.key === "verify" ? { ...s, status: "error" } : s));
      setSequenceError("Embedded controller reported tip change failure.");
    };
    window.addEventListener("tip-change-ok",   ok);
    window.addEventListener("tip-change-fail", fail);
    return () => {
      window.removeEventListener("tip-change-ok",   ok);
      window.removeEventListener("tip-change-fail", fail);
    };
  }, []);

  // ── Helpers ──────────────────────────────────────────────────────────────

  const markStep = useCallback((key, status) => {
    setSequenceSteps(prev => prev.map(s => s.key === key ? { ...s, status } : s));
  }, []);

  const send = async (line) => { if (window.serial?.writeLine) await window.serial.writeLine(line); };
  const pause = (ms) => new Promise(r => setTimeout(r, ms));

  // ── Tip CRUD ─────────────────────────────────────────────────────────────

  const addTip = useCallback((overrides = {}) => {
    const tip = newTip(overrides);
    setTipLibrary(prev => [...prev, tip]);
    return tip.id;
  }, []);

  const updateTip = useCallback((id, patch) => {
    setTipLibrary(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
  }, []);

  const removeTip = useCallback((id) => {
    setTipLibrary(prev => prev.filter(t => t.id !== id));
    setSlots(prev => prev.map(s => s.tipId === id ? { ...s, tipId: null } : s));
    if (activeTipId === id) { setActiveTipId(null); setVerificationState(TIP_VERIFY.UNVERIFIED); }
  }, [activeTipId]);

  // ── Slot management ──────────────────────────────────────────────────────

  const setSlotCount = useCallback((count) => {
    const n = Math.max(4, Math.min(Number(count) || 4, 20));
    setSlots(prev => {
      if (n > prev.length) return [...prev, ...Array.from({ length: n - prev.length }, (_, i) => newSlot(prev.length + i))];
      return prev.slice(0, n);
    });
  }, []);

  const saveSlotPosition = useCallback((slotIndex, position) => {
    setSlots(prev => prev.map((s, i) => i === slotIndex ? { ...s, position: { ...position } } : s));
  }, []);

  const assignTipToSlot = useCallback((slotIndex, tipId) => {
    setSlots(prev => prev.map((s, i) => i === slotIndex ? { ...s, tipId: tipId || null } : s));
    if (tipId) setTipLibrary(prev => prev.map(t => t.id === tipId ? { ...t, slotIndex } : t));
  }, []);

  // ── Tip-change sequence ───────────────────────────────────────────────────

  const runTipChangeSequence = useCallback(async (fromTipId, toTipId) => {
    if (sequenceRunning) return;
    if (!window.serial?.writeLine) {
      setSequenceError("Machine not connected — cannot run tip change sequence.");
      return;
    }
    const fromTip    = tipLibrary.find(t => t.id === fromTipId) ?? null;
    const toTip      = tipLibrary.find(t => t.id === toTipId);
    if (!toTip) { setSequenceError("Target tip not found in library."); return; }

    const dropSlot   = (fromTip !== null && slots[fromTip.slotIndex]?.position?.x !== null) ? slots[fromTip.slotIndex] : null;
    const pickupSlot = slots[toTip.slotIndex];

    if (!pickupSlot?.position?.x) {
      setSequenceError(`Pickup slot ${toTip.slotIndex + 1} position not calibrated.`);
      return;
    }

    abortRef.current = false;
    setSequenceRunning(true);
    setSequenceError(null);
    setTargetTipId(toTipId);
    setVerificationState(TIP_VERIFY.UNVERIFIED);
    setSequenceSteps(SEQUENCE_STEPS.map(s => ({ ...s, status: "pending" })));

    const check = () => { if (abortRef.current) throw new Error("ABORTED"); };

    try {
      // Safe Z lift
      markStep("safe_z", "running");
      await send("G90"); await send("G0 Z5 F3000"); await pause(800); check();
      markStep("safe_z", "done");

      if (dropSlot) {
        // Move to drop slot
        markStep("move_drop", "running");
        await send(`G0 X${dropSlot.position.x.toFixed(3)} Y${dropSlot.position.y.toFixed(3)} F6000`);
        await pause(1200); check(); markStep("move_drop", "done");
        // Lower
        markStep("lower_drop", "running");
        await send(`G0 Z${(dropSlot.position.z ?? 0).toFixed(3)} F1000`);
        await pause(800); check(); markStep("lower_drop", "done");
        // Release
        markStep("release", "running");
        await send("G4 P500"); await pause(600); check(); markStep("release", "done");
        // Lift
        markStep("lift_drop", "running");
        await send("G0 Z5 F3000"); await pause(600); check(); markStep("lift_drop", "done");
      } else {
        ["move_drop", "lower_drop", "release", "lift_drop"].forEach(k => markStep(k, "skipped"));
      }

      // Move to pickup slot
      markStep("move_pickup", "running");
      await send(`G0 X${pickupSlot.position.x.toFixed(3)} Y${pickupSlot.position.y.toFixed(3)} F6000`);
      await pause(1200); check(); markStep("move_pickup", "done");
      // Lower
      markStep("lower_pickup", "running");
      await send(`G0 Z${(pickupSlot.position.z ?? 0).toFixed(3)} F1000`);
      await pause(800); check(); markStep("lower_pickup", "done");
      // Seat
      markStep("seat", "running");
      await send("G4 P500"); await pause(600); check(); markStep("seat", "done");
      // Lift with new tip
      markStep("lift_pickup", "running");
      await send("G0 Z5 F3000"); await pause(600); check(); markStep("lift_pickup", "done");

      // Apply offset — G10 L2 P1 (Marlin/Grbl work coordinate offset)
      markStep("apply_offset", "running");
      const { dx = 0, dy = 0, dz = 0 } = toTip.toolOffset;
      await send(`G10 L2 P1 X${dx.toFixed(3)} Y${dy.toFixed(3)} Z${dz.toFixed(3)}`);
      await pause(300); check(); markStep("apply_offset", "done");

      // Verify — send M115 (Marlin firmware query, embedded may annotate reply)
      // and wait up to 3s for TIP_STATUS or TIP_CHANGE_OK event from embedded
      markStep("verify", "running");
      await send("M115");
      await pause(3000);
      // If no event updated verification, leave as UNVERIFIED (not FAILED)
      setVerificationState(prev => prev === TIP_VERIFY.VERIFIED ? TIP_VERIFY.VERIFIED : TIP_VERIFY.UNVERIFIED);
      markStep("verify", "done");

      // Commit active tip
      setActiveTipId(toTipId);
      setTipLibrary(prev => prev.map(t =>
        t.id === toTipId ? { ...t, presenceConfirmed: true, lastVerified: new Date().toISOString() } : t
      ));

    } catch (err) {
      const msg = err.message === "ABORTED" ? "Sequence aborted by operator." : `Sequence failed: ${err.message}`;
      setSequenceError(msg);
      setSequenceSteps(prev => prev.map(s => s.status === "running" ? { ...s, status: "error" } : s));
      setVerificationState(TIP_VERIFY.FAILED);
    } finally {
      setSequenceRunning(false);
    }
  }, [sequenceRunning, tipLibrary, slots, markStep]);

  const abortSequence = useCallback(() => { abortRef.current = true; }, []);

  const resetSequence = useCallback(() => {
    setSequenceSteps(SEQUENCE_STEPS.map(s => ({ ...s, status: "pending" })));
    setSequenceError(null);
    abortRef.current = false;
  }, []);

  // ── Pre-run validation ────────────────────────────────────────────────────

  const validateForRun = useCallback(() => {
    const issues = [];
    if (!activeTipId) { issues.push("No soldering tip is set as active."); return { valid: false, issues }; }
    const tip = tipLibrary.find(t => t.id === activeTipId);
    if (!tip)          { issues.push("Active tip not found in library.");   return { valid: false, issues }; }
    if (verificationState === TIP_VERIFY.FAILED)      issues.push(`Tip "${tip.name}" failed verification.`);
    if (verificationState === TIP_VERIFY.UNVERIFIED)  issues.push(`Tip "${tip.name}" has not been verified since last change.`);
    const { dx, dy, dz } = tip.toolOffset;
    if (Math.abs(dx) > 50 || Math.abs(dy) > 50 || Math.abs(dz) > 50)
      issues.push(`Tip "${tip.name}" has an unusually large offset — please re-calibrate.`);
    return { valid: issues.length === 0, issues };
  }, [activeTipId, tipLibrary, verificationState]);

  // ── Manual recovery ───────────────────────────────────────────────────────

  const manualConfirmTip = useCallback((tipId) => {
    setActiveTipId(tipId);
    setVerificationState(TIP_VERIFY.VERIFIED);
    setTipLibrary(prev => prev.map(t =>
      t.id === tipId ? { ...t, presenceConfirmed: true, lastVerified: new Date().toISOString() } : t
    ));
  }, []);

  const activeTip = tipLibrary.find(t => t.id === activeTipId) ?? null;

  return {
    tipLibrary, slots, activeTipId, activeTip, verificationState,
    sequenceRunning, sequenceSteps, sequenceError, targetTipId,
    addTip, updateTip, removeTip,
    setSlotCount, saveSlotPosition, assignTipToSlot,
    runTipChangeSequence, abortSequence, resetSequence,
    validateForRun, manualConfirmTip,
    setActiveTipId,
  };
}
