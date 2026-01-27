export class PressureController {
  constructor() {
    this.presets = {
      low: { name: "Low Viscosity (Flux)", pressure: 15, flowRate: 1.2, dwellTime: 80 },
      medium: { name: "Medium Viscosity (Standard)", pressure: 25, flowRate: 1.0, dwellTime: 120 },
      high: { name: "High Viscosity (Thick)", pressure: 40, flowRate: 0.8, dwellTime: 180 },
      custom: { name: "Custom", pressure: 25, flowRate: 1.0, dwellTime: 120 }
    };
  }

  getPreset(type) {
    return this.presets[type] || this.presets.medium;
  }

  calculatePressure(padSize, viscosity = 'medium') {
    const preset = this.getPreset(viscosity);
    const area = padSize.width * padSize.height;
    
    // Adjust pressure based on pad area (smaller pads need higher pressure)
    let pressureMultiplier = 1.0;
    if (area < 0.5) pressureMultiplier = 1.3;      // Small pads
    else if (area < 2.0) pressureMultiplier = 1.1; // Medium pads
    else if (area > 10.0) pressureMultiplier = 0.8; // Large pads
    
    return Math.round(preset.pressure * pressureMultiplier);
  }

  calculateDwellTime(padSize, viscosity = 'medium') {
    const preset = this.getPreset(viscosity);
    const area = padSize.width * padSize.height;
    
    // Adjust dwell time based on pad area
    let timeMultiplier = 1.0;
    if (area < 0.5) timeMultiplier = 0.8;      // Small pads - less time
    else if (area > 10.0) timeMultiplier = 1.5; // Large pads - more time
    
    return Math.round(preset.dwellTime * timeMultiplier);
  }

  generatePressureGcode(pressure, viscosity = 'medium') {
    const preset = this.getPreset(viscosity);
    
    // Generate G-code for pressure control (adjust based on your hardware)
    return [
      `; Pressure control for ${preset.name}`,
      `M42 P4 S${Math.round((pressure / 100) * 255)}`, // PWM pressure control
      `; Flow rate: ${preset.flowRate}x, Pressure: ${pressure} PSI`
    ];
  }
}

export const VISCOSITY_TYPES = {
  low: "Low Viscosity (Flux)",
  medium: "Medium Viscosity (Standard)", 
  high: "High Viscosity (Thick)",
  custom: "Custom"
};