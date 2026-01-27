/**
 * Coordinate System Debug Utilities
 */

export function debugCoordinateConversion(clickEvent, svgElement, padData) {
  console.group('🔍 Coordinate Debug Analysis');
  
  // 1. Mouse/Click coordinates
  console.log('1. Click Event:', {
    clientX: clickEvent.clientX,
    clientY: clickEvent.clientY,
    pageX: clickEvent.pageX,
    pageY: clickEvent.pageY
  });
  
  // 2. SVG Element properties
  const svgRect = svgElement.getBoundingClientRect();
  const viewBox = svgElement.getAttribute('viewBox');
  const width = svgElement.getAttribute('width');
  const height = svgElement.getAttribute('height');
  
  console.log('2. SVG Properties:', {
    viewBox,
    width,
    height,
    boundingRect: svgRect
  });
  
  // 3. SVG Point conversion
  const pt = svgElement.createSVGPoint();
  pt.x = clickEvent.clientX;
  pt.y = clickEvent.clientY;
  const ctm = svgElement.getScreenCTM();
  const localPt = pt.matrixTransform(ctm.inverse());
  
  console.log('3. SVG Coordinate Conversion:', {
    screenPoint: { x: pt.x, y: pt.y },
    localPoint: { x: localPt.x, y: localPt.y },
    ctm: {
      a: ctm.a, b: ctm.b, c: ctm.c,
      d: ctm.d, e: ctm.e, f: ctm.f
    }
  });
  
  console.groupEnd();
}