// Nozzle maintenance and cleaning reminders
export class NozzleMaintenanceManager {
  constructor() {
    this.dispenseCount = this.loadFromStorage('nozzleDispenseCount', 0);
    this.lastCleaningTime = this.loadFromStorage('lastNozzleCleaning', Date.now());
    this.settings = this.loadFromStorage('nozzleMaintenanceSettings', {
      maxDispensesBeforeCleaning: 100,
      maxHoursBeforeCleaning: 4,
      reminderIntervalMinutes: 30,
      autoReminders: true
    });
    this.reminderCallback = null;
    this.toolOffset = this.loadFromStorage('toolOffset', { dx: 0, dy: 0 });
    this.pixelsPerMm = this.loadFromStorage('pixelsPerMm', 20);
    this.purgeStation = this.loadFromStorage('purgeStation', { x: 0, y: 0, z: 5, configured: false });
  }

  getPurgeStation() {
    return this.purgeStation;
  }

  setPurgeStation(pos) {
    this.purgeStation = { ...this.purgeStation, ...pos, configured: true };
    this.saveToStorage('purgeStation', this.purgeStation);
  }

  getToolOffset() {
    return this.toolOffset;
  }

  setToolOffset(offset) {
    this.toolOffset = { ...this.toolOffset, ...offset };
    this.saveToStorage('toolOffset', this.toolOffset);
  }

  getPixelsPerMm() {
    return this.pixelsPerMm;
  }

  setPixelsPerMm(val) {
    this.pixelsPerMm = val;
    this.saveToStorage('pixelsPerMm', this.pixelsPerMm);
  }

  // Record a dispense operation
  recordDispense() {
    this.dispenseCount++;
    this.saveToStorage('nozzleDispenseCount', this.dispenseCount);

    if (this.shouldRemindCleaning()) {
      this.triggerCleaningReminder();
    }
  }

  // Check if cleaning reminder should be shown
  shouldRemindCleaning() {
    if (!this.settings.autoReminders) return false;

    const hoursSinceLastCleaning = (Date.now() - this.lastCleaningTime) / (1000 * 60 * 60);
    const dispensesExceeded = this.dispenseCount >= this.settings.maxDispensesBeforeCleaning;
    const timeExceeded = hoursSinceLastCleaning >= this.settings.maxHoursBeforeCleaning;

    return dispensesExceeded || timeExceeded;
  }

  // Trigger cleaning reminder
  triggerCleaningReminder() {
    const reason = this.getCleaningReason();

    if (this.reminderCallback) {
      this.reminderCallback({
        type: 'cleaning_reminder',
        reason,
        dispenseCount: this.dispenseCount,
        hoursSinceLastCleaning: (Date.now() - this.lastCleaningTime) / (1000 * 60 * 60),
        timestamp: Date.now()
      });
    }
  }

  // Get reason for cleaning reminder
  getCleaningReason() {
    const hoursSinceLastCleaning = (Date.now() - this.lastCleaningTime) / (1000 * 60 * 60);
    const dispensesExceeded = this.dispenseCount >= this.settings.maxDispensesBeforeCleaning;
    const timeExceeded = hoursSinceLastCleaning >= this.settings.maxHoursBeforeCleaning;

    if (dispensesExceeded && timeExceeded) {
      return 'both_limits_exceeded';
    } else if (dispensesExceeded) {
      return 'dispense_limit_exceeded';
    } else if (timeExceeded) {
      return 'time_limit_exceeded';
    }

    return 'unknown';
  }

  // Mark nozzle as cleaned
  markCleaned() {
    this.dispenseCount = 0;
    this.lastCleaningTime = Date.now();

    this.saveToStorage('nozzleDispenseCount', this.dispenseCount);
    this.saveToStorage('lastNozzleCleaning', this.lastCleaningTime);

    if (this.reminderCallback) {
      this.reminderCallback({
        type: 'cleaning_completed',
        timestamp: Date.now()
      });
    }
  }

  // Get maintenance status
  getMaintenanceStatus() {
    const hoursSinceLastCleaning = (Date.now() - this.lastCleaningTime) / (1000 * 60 * 60);
    const dispensesRemaining = Math.max(0, this.settings.maxDispensesBeforeCleaning - this.dispenseCount);
    const hoursRemaining = Math.max(0, this.settings.maxHoursBeforeCleaning - hoursSinceLastCleaning);

    return {
      dispenseCount: this.dispenseCount,
      dispensesRemaining,
      hoursSinceLastCleaning: Math.round(hoursSinceLastCleaning * 10) / 10,
      hoursRemaining: Math.round(hoursRemaining * 10) / 10,
      needsCleaning: this.shouldRemindCleaning(),
      lastCleaningTime: this.lastCleaningTime,
      settings: this.settings
    };
  }

  // Combined health score: 0–100 (higher = healthier)
  // wearScore:    0–50 — based on dispense count vs cleaning threshold
  // qualityScore: 0–50 — based on recent SPC pass rates (last 5 jobs)
  getNozzleHealthScore(spcJobs = []) {
    const status = this.getMaintenanceStatus();

    const wearRatio = Math.min(1, status.dispenseCount / Math.max(1, status.settings.maxDispensesBeforeCleaning));
    const wearScore = (1 - wearRatio) * 50;

    const recentJobs = spcJobs.slice(-5).filter(j => j.checked > 0);
    let qualityScore;
    if (recentJobs.length === 0) {
      qualityScore = 25; // no SPC data: assume neutral
    } else {
      const avgPassRate = recentJobs.reduce((s, j) => s + j.passRate, 0) / recentJobs.length;
      qualityScore = avgPassRate * 50;
      // Monotonically declining pass-rate trend in last 3 jobs → extra -5 penalty
      if (recentJobs.length >= 3) {
        const last3 = recentJobs.slice(-3);
        if (last3[2].passRate < last3[1].passRate && last3[1].passRate < last3[0].passRate) {
          qualityScore = Math.max(0, qualityScore - 5);
        }
      }
    }

    const score = Math.round(wearScore + qualityScore);
    const level = score >= 75 ? 'good' : score >= 50 ? 'warn' : 'critical';

    let recommendation;
    if (level === 'good') {
      recommendation = 'Nozzle healthy';
    } else if (level === 'warn') {
      recommendation = status.needsCleaning ? 'Clean nozzle now' : 'Clean nozzle soon';
    } else {
      const qualityDriven = recentJobs.length > 0 && recentJobs[recentJobs.length - 1].passRate < 0.5;
      recommendation = qualityDriven ? 'Poor dot quality — consider replacement' : 'Clean nozzle now';
    }

    return {
      score,
      level,
      recommendation,
      wearScore: Math.round(wearScore),
      qualityScore: Math.round(qualityScore),
    };
  }

  // Update maintenance settings
  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    this.saveToStorage('nozzleMaintenanceSettings', this.settings);
  }

  // Set reminder callback
  setReminderCallback(callback) {
    this.reminderCallback = callback;
  }

  // Generate cleaning G-code sequence
  generateCleaningGcode(settings = {}) {
    const {
      cleaningPosition = { x: 0, y: 0, z: 10 },
      purgeAmount = 5, // mm of filament/paste
      purgeSpeed = 300, // mm/min
      wipePattern = 'linear', // 'linear' or 'circular'
      wipeDistance = 10 // mm
    } = settings;

    const gcode = [];

    gcode.push('; --- Nozzle Cleaning Sequence ---');
    gcode.push('G21 ; Set units to millimeters');
    gcode.push('G90 ; Absolute positioning');

    // Move to cleaning position
    gcode.push(`G0 Z${cleaningPosition.z + 5}`);
    gcode.push(`G0 X${cleaningPosition.x} Y${cleaningPosition.y}`);
    gcode.push(`G1 Z${cleaningPosition.z} F300`);

    // Purge material
    gcode.push(`; Purge ${purgeAmount}mm of material`);
    gcode.push('M106 S255 ; Turn on purge valve');
    gcode.push(`G4 P${purgeAmount * 1000 / (purgeSpeed / 60)} ; Purge time`);
    gcode.push('M107 ; Turn off purge valve');

    // Wipe pattern
    if (wipePattern === 'linear') {
      gcode.push(`; Linear wipe pattern`);
      gcode.push(`G1 X${cleaningPosition.x + wipeDistance} F${purgeSpeed}`);
      gcode.push(`G1 X${cleaningPosition.x - wipeDistance}`);
      gcode.push(`G1 X${cleaningPosition.x}`);
    } else if (wipePattern === 'circular') {
      gcode.push(`; Circular wipe pattern`);
      const radius = wipeDistance / 2;
      gcode.push(`G2 X${cleaningPosition.x + radius} Y${cleaningPosition.y} I${radius} J0 F${purgeSpeed}`);
      gcode.push(`G2 X${cleaningPosition.x} Y${cleaningPosition.y} I${-radius} J0`);
    }

    // Return to safe position
    gcode.push(`G0 Z${cleaningPosition.z + 5}`);
    gcode.push('; --- End Cleaning Sequence ---');

    return gcode.join('\n');
  }

  // Load data from localStorage
  loadFromStorage(key, defaultValue) {
    try {
      const stored = localStorage.getItem(`nozzleMaintenance_${key}`);
      return stored ? JSON.parse(stored) : defaultValue;
    } catch (error) {
      console.warn(`Failed to load ${key} from storage:`, error);
      return defaultValue;
    }
  }

  // Save data to localStorage
  saveToStorage(key, value) {
    try {
      localStorage.setItem(`nozzleMaintenance_${key}`, JSON.stringify(value));
    } catch (error) {
      console.warn(`Failed to save ${key} to storage:`, error);
    }
  }

  // Reset all maintenance data
  reset() {
    this.dispenseCount = 0;
    this.lastCleaningTime = Date.now();

    this.saveToStorage('nozzleDispenseCount', this.dispenseCount);
    this.saveToStorage('lastNozzleCleaning', this.lastCleaningTime);
  }
}