export class SpeedProfileManager {
  constructor() {
    this.profiles = {
      micro: {
        name: "Micro Pads (< 0.5mm)",
        minArea: 0,
        maxArea: 0.25, // 0.5 x 0.5 mm
        travelSpeed: 6000, // mm/min (Was 3000)
        approachSpeed: 1000, // mm/min (Was 600)
        dispenseSpeed: 300, // mm/min (Slightly faster)
        retractSpeed: 2000, // mm/min (Was 1200)
        description: "Ultra-precise for tiny components"
      },
      small: {
        name: "Small Pads (0.5-1.5mm)",
        minArea: 0.25,
        maxArea: 2.25, // 1.5 x 1.5 mm
        travelSpeed: 8000, // mm/min (Was 4000)
        approachSpeed: 1500, // mm/min (Was 800)
        dispenseSpeed: 500, // mm/min
        retractSpeed: 3000, // mm/min (Was 1500)
        description: "Standard for resistors, capacitors"
      },
      medium: {
        name: "Medium Pads (1.5-4mm)",
        minArea: 2.25,
        maxArea: 16, // 4 x 4 mm
        travelSpeed: 10000, // mm/min (Was 5000)
        approachSpeed: 2000, // mm/min (Was 1000)
        dispenseSpeed: 600, // mm/min
        retractSpeed: 4000, // mm/min (Was 2000)
        description: "ICs, connectors, larger components"
      },
      large: {
        name: "Large Pads (> 4mm)",
        minArea: 16,
        maxArea: Infinity,
        travelSpeed: 12000, // mm/min (Was 6000)
        approachSpeed: 2500, // mm/min (Was 1200)
        dispenseSpeed: 800, // mm/min
        retractSpeed: 5000, // mm/min (Was 2500)
        description: "Power components, large connectors"
      }
    };
    this.currentSettings = { globalMultiplier: 1.0, autoAdjust: true };
  }

  updateSettings(settings) {
    if (settings) this.currentSettings = { ...this.currentSettings, ...settings };
  }

  getProfileForPad(pad) {
    const area = (pad.width || 1) * (pad.height || 1);

    for (const [key, profile] of Object.entries(this.profiles)) {
      if (area >= profile.minArea && area < profile.maxArea) {
        return { ...profile, key, area };
      }
    }

    // Default to medium if no match
    return { ...this.profiles.medium, key: 'medium', area };
  }

  calculateOptimalSpeeds(pad, viscosity = 'medium') {
    const baseProfile = this.getProfileForPad(pad);
    const area = (pad.width || 1) * (pad.height || 1);

    // Viscosity multipliers
    const viscosityMultipliers = {
      low: { travel: 1.2, approach: 1.1, dispense: 1.3, retract: 1.1 },
      medium: { travel: 1.0, approach: 1.0, dispense: 1.0, retract: 1.0 },
      high: { travel: 0.9, approach: 0.8, dispense: 0.7, retract: 0.9 },
      custom: { travel: 1.0, approach: 1.0, dispense: 1.0, retract: 1.0 }
    };

    const multiplier = viscosityMultipliers[viscosity] || viscosityMultipliers.medium;
    const globalMult = this.currentSettings?.globalMultiplier || 1.0;

    // Area-based fine tuning within profile range
    const areaRatio = (area - baseProfile.minArea) / (baseProfile.maxArea - baseProfile.minArea);
    const areaFactor = 1 + (areaRatio * 0.2); // Up to 20% speed increase for larger pads in same category

    return {
      profile: baseProfile,
      speeds: {
        travel: Math.round(baseProfile.travelSpeed * multiplier.travel * areaFactor * globalMult),
        approach: Math.round(baseProfile.approachSpeed * multiplier.approach * globalMult),
        dispense: Math.round(baseProfile.dispenseSpeed * multiplier.dispense * globalMult),
        retract: Math.round(baseProfile.retractSpeed * multiplier.retract * globalMult)
      },
      area,
      viscosityAdjusted: viscosity !== 'medium'
    };
  }

  generateSpeedGcode(speeds, comment = "") {
    return [
      comment ? `; ${comment}` : "; Speed profile adjustment",
      `; Travel: ${speeds.travel} mm/min, Approach: ${speeds.approach} mm/min`,
      `; Dispense: ${speeds.dispense} mm/min, Retract: ${speeds.retract} mm/min`
    ];
  }

  getAllProfiles() {
    return this.profiles;
  }

  getProfileStats(pads) {
    const stats = {};
    pads.forEach(pad => {
      const profile = this.getProfileForPad(pad);
      if (!stats[profile.key]) {
        stats[profile.key] = { count: 0, profile: profile };
      }
      stats[profile.key].count++;
    });

    return stats;
  }
}