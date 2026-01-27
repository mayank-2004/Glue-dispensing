// Collision detection for nozzle movement
export class CollisionDetector {
  constructor(components = [], nozzleDia = 0.6, safeHeight = 6) {
    this.components = components;
    this.nozzleDia = nozzleDia;
    this.safeHeight = safeHeight;
    this.componentHeight = 2.0; // Default component height in mm
  }

  // Check if nozzle path collides with components
  checkPath(from, to, currentZ = 0) {
    const collisions = [];
    
    // If moving at safe height, no collision
    if (currentZ >= this.safeHeight) return collisions;
    
    const path = this.interpolatePath(from, to);
    
    for (const point of path) {
      const collision = this.checkPoint(point, currentZ);
      if (collision) collisions.push(collision);
    }
    
    return collisions;
  }

  // Check collision at specific point
  checkPoint(point, z = 0) {
    if (z >= this.safeHeight) return null;
    
    const nozzleRadius = this.nozzleDia / 2;
    
    for (const comp of this.components) {
      const dx = Math.abs(point.x - comp.x);
      const dy = Math.abs(point.y - comp.y);
      const compRadius = Math.max(comp.width || 1, comp.height || 1) / 2;
      
      // Check if nozzle overlaps with component
      if (dx < (nozzleRadius + compRadius) && dy < (nozzleRadius + compRadius)) {
        const distance = Math.hypot(dx, dy);
        if (distance < (nozzleRadius + compRadius)) {
          return {
            component: comp,
            point: point,
            clearance: distance - (nozzleRadius + compRadius)
          };
        }
      }
    }
    
    return null;
  }

  // Generate safe path avoiding collisions
  generateSafePath(from, to) {
    const directCollisions = this.checkPath(from, to, 0);
    
    if (directCollisions.length === 0) {
      return [from, to]; // Direct path is safe
    }
    
    // Generate path with intermediate safe points
    return [
      from,
      { x: from.x, y: from.y, z: this.safeHeight },
      { x: to.x, y: to.y, z: this.safeHeight },
      to
    ];
  }

  interpolatePath(from, to, steps = 10) {
    const path = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      path.push({
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        z: from.z || 0
      });
    }
    return path;
  }

  // Update component list
  updateComponents(components) {
    this.components = components;
  }

  // Update nozzle diameter
  updateNozzle(diameter) {
    this.nozzleDia = diameter;
  }
}