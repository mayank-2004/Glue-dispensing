const IN2MM = 25.4;

/**
 * Detect potential origin points in PCB from Gerber layers
 */
export function detectPcbOrigins(layers) {
  // Always return the True Gerber Origin at (0,0) as the primary origin
  return [{
    x: 0,
    y: 0,
    type: 'true_gerber_origin',
    subtype: 'center',
    confidence: 1.0,
    description: 'True Gerber Origin (0,0)'
  }];
}

