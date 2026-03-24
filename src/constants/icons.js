/** Shade a hex color by a factor (0 = black, 1 = original) */
export function shadeHex(hex, factor) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${Math.round(r * factor)},${Math.round(g * factor)},${Math.round(b * factor)})`;
}

/** Returns fill color for a face type given the base kind color */
export function faceColor(face, baseColor) {
  switch (face) {
    case "top":    return shadeHex(baseColor, 1.0);
    case "front":  return shadeHex(baseColor, 0.65);
    case "side":   return shadeHex(baseColor, 0.4);
    case "led":    return "#22C55E";
    case "dark":   return "rgba(0,0,0,0.5)";
    case "accent": return baseColor;
    default:       return baseColor;
  }
}

/* ── Isometric 3D icon shape definitions ──
   Each icon: array of { t, face, ...attrs }
   t: 'path' | 'line' | 'circle'
   face: 'top' | 'front' | 'side' | 'line' | 'led' | 'dark' | 'accent'
   All coordinates centered at (0,0)                                    */

const serverRack = [
  { t: "path", d: "M0,20 L-22,9 L-22,-27 L0,-16 Z", face: "side" },
  { t: "path", d: "M0,20 L22,9 L22,-27 L0,-16 Z", face: "front" },
  { t: "path", d: "M0,-16 L22,-27 L0,-38 L-22,-27 Z", face: "top" },
  // shelf lines – left face
  { t: "line", x1: -21, y1: -19, x2: -1, y2: -8, face: "line" },
  { t: "line", x1: -21, y1: -7,  x2: -1, y2: 4,  face: "line" },
  // shelf lines – right face
  { t: "line", x1: 1, y1: -8, x2: 21, y2: -19, face: "line" },
  { t: "line", x1: 1, y1: 4,  x2: 21, y2: -7,  face: "line" },
  // LED indicators
  { t: "circle", cx: -17, cy: -22, r: 1.5, face: "led" },
  { t: "circle", cx: -17, cy: -10, r: 1.5, face: "led" },
];

const pod = [
  { t: "path", d: "M0,12 L-16,4 L-16,-16 L0,-8 Z", face: "side" },
  { t: "path", d: "M0,12 L16,4 L16,-16 L0,-8 Z", face: "front" },
  { t: "path", d: "M0,-8 L16,-16 L0,-24 L-16,-16 Z", face: "top" },
];

const replicaSet = [
  // back box (ghosted)
  { t: "path", d: "M6,6 L-10,-2 L-10,-20 L6,-12 Z",   face: "side",  opacity: 0.35 },
  { t: "path", d: "M6,6 L22,-2 L22,-20 L6,-12 Z",      face: "front", opacity: 0.35 },
  { t: "path", d: "M6,-12 L22,-20 L6,-28 L-10,-20 Z",  face: "top",   opacity: 0.35 },
  // front box
  { t: "path", d: "M-4,14 L-20,6 L-20,-12 L-4,-4 Z",   face: "side" },
  { t: "path", d: "M-4,14 L12,6 L12,-12 L-4,-4 Z",     face: "front" },
  { t: "path", d: "M-4,-4 L12,-12 L-4,-20 L-20,-12 Z", face: "top" },
];

const switchBox = [
  { t: "path", d: "M0,6 L-26,-7 L-26,-17 L0,-4 Z", face: "side" },
  { t: "path", d: "M0,6 L26,-7 L26,-17 L0,-4 Z",   face: "front" },
  { t: "path", d: "M0,-4 L26,-17 L0,-30 L-26,-17 Z", face: "top" },
  // port LEDs
  { t: "circle", cx: -8,  cy: 0,  r: 1.5, face: "led" },
  { t: "circle", cx: 0,   cy: -3, r: 1.5, face: "led" },
  { t: "circle", cx: 8,   cy: -6, r: 1.5, face: "led" },
  { t: "circle", cx: -14, cy: 3,  r: 1.5, face: "led" },
  { t: "circle", cx: 14,  cy: -9, r: 1.5, face: "led" },
];

const cylinder = [
  // body
  { t: "path", d: "M-18,-10 L-18,8 Q-18,18 0,18 Q18,18 18,8 L18,-10 Z", face: "front" },
  // top cap
  { t: "path", d: "M-18,-10 Q-18,-22 0,-22 Q18,-22 18,-10 Q18,2 0,2 Q-18,2 -18,-10 Z", face: "top" },
  // middle band
  { t: "path", d: "M-18,0 Q-18,10 0,10 Q18,10 18,0", face: "line", noFill: true },
];

const gateway = [
  // main front face
  { t: "path", d: "M-16,18 L-16,-16 L0,-28 L16,-16 L16,18 Z", face: "front" },
  // 3D top
  { t: "path", d: "M-16,-16 L0,-28 L8,-32 L24,-20 L16,-16 Z", face: "top" },
  // 3D right side
  { t: "path", d: "M16,-16 L24,-20 L24,14 L16,18 Z", face: "side" },
  // archway cutout
  { t: "path", d: "M-7,18 L-7,0 Q0,-8 7,0 L7,18 Z", face: "dark" },
];

const document = [
  // front face
  { t: "path", d: "M-12,16 L-12,-16 L12,-16 L12,16 Z", face: "front" },
  // top edge
  { t: "path", d: "M-12,-16 L-6,-22 L18,-22 L12,-16 Z", face: "top" },
  // right edge
  { t: "path", d: "M12,-16 L18,-22 L18,10 L12,16 Z", face: "side" },
  // text lines
  { t: "line", x1: -6, y1: -6, x2: 6, y2: -6, face: "line" },
  { t: "line", x1: -6, y1: 0,  x2: 6, y2: 0,  face: "line" },
  { t: "line", x1: -6, y1: 6,  x2: 2, y2: 6,  face: "line" },
];

const gear = [
  // outer gear shape
  { t: "path", d: "M-3,-18 L3,-18 L5,-14 L12,-12 L14,-6 L12,0 L14,6 L12,12 L5,14 L3,18 L-3,18 L-5,14 L-12,12 L-14,6 L-12,0 L-14,-6 L-12,-12 L-5,-14 Z", face: "front" },
  // center hole
  { t: "circle", cx: 0, cy: 0, r: 6, face: "dark" },
  // 3D depth on top teeth
  { t: "path", d: "M-3,-18 L0,-22 L6,-22 L3,-18 Z", face: "top" },
  { t: "path", d: "M12,-12 L16,-15 L18,-9 L14,-6 Z", face: "top" },
];

const nodeMachine = [
  { t: "path", d: "M0,24 L-24,12 L-24,-28 L0,-16 Z", face: "side" },
  { t: "path", d: "M0,24 L24,12 L24,-28 L0,-16 Z", face: "front" },
  { t: "path", d: "M0,-16 L24,-28 L0,-40 L-24,-28 Z", face: "top" },
  // drive bay lines – left
  { t: "line", x1: -23, y1: -20, x2: -1, y2: -8,  face: "line" },
  { t: "line", x1: -23, y1: -8,  x2: -1, y2: 4,   face: "line" },
  { t: "line", x1: -23, y1: 4,   x2: -1, y2: 16,  face: "line" },
  // drive bay lines – right
  { t: "line", x1: 1, y1: -8,  x2: 23, y2: -20, face: "line" },
  { t: "line", x1: 1, y1: 4,   x2: 23, y2: -8,  face: "line" },
  { t: "line", x1: 1, y1: 16,  x2: 23, y2: 4,   face: "line" },
  // LED indicators
  { t: "circle", cx: -19, cy: -23, r: 2, face: "led" },
  { t: "circle", cx: -19, cy: -11, r: 2, face: "led" },
  { t: "circle", cx: -19, cy: 1,   r: 2, face: "led" },
];

const scaling = [
  // back box
  { t: "path", d: "M6,4 L-8,-2 L-8,-14 L6,-8 Z",       face: "side",  opacity: 0.35 },
  { t: "path", d: "M6,4 L20,-2 L20,-14 L6,-8 Z",        face: "front", opacity: 0.35 },
  { t: "path", d: "M6,-8 L20,-14 L6,-20 L-8,-14 Z",     face: "top",   opacity: 0.35 },
  // middle box
  { t: "path", d: "M0,12 L-14,6 L-14,-6 L0,0 Z",        face: "side",  opacity: 0.65 },
  { t: "path", d: "M0,12 L14,6 L14,-6 L0,0 Z",          face: "front", opacity: 0.65 },
  { t: "path", d: "M0,0 L14,-6 L0,-12 L-14,-6 Z",       face: "top",   opacity: 0.65 },
  // front box
  { t: "path", d: "M-6,20 L-20,14 L-20,2 L-6,8 Z",      face: "side" },
  { t: "path", d: "M-6,20 L8,14 L8,2 L-6,8 Z",          face: "front" },
  { t: "path", d: "M-6,8 L8,2 L-6,-4 L-20,2 Z",         face: "top" },
];

const shield = [
  { t: "path", d: "M0,-22 L18,-12 L18,4 L0,18 L-18,4 L-18,-12 Z", face: "front" },
  { t: "path", d: "M0,-22 L5,-26 L23,-16 L18,-12 Z", face: "top" },
  { t: "path", d: "M18,-12 L23,-16 L23,0 L18,4 Z", face: "side" },
  // check mark
  { t: "line", x1: -6, y1: 0, x2: -1, y2: 6, face: "accent", strokeWidth: 2.5 },
  { t: "line", x1: -1, y1: 6, x2: 8, y2: -6, face: "accent", strokeWidth: 2.5 },
];

export const KIND_ICON = {
  Deployment:             serverRack,
  StatefulSet:            serverRack,
  DaemonSet:              serverRack,
  Pod:                    pod,
  ReplicaSet:             replicaSet,
  Service:                switchBox,
  NetworkPolicy:          switchBox,
  Ingress:                gateway,
  Node:                   nodeMachine,
  AzureService:           cylinder,
  PersistentVolumeClaim:  cylinder,
  ConfigMap:              document,
  Secret:                 document,
  Job:                    gear,
  CronJob:                gear,
  HorizontalPodAutoscaler: scaling,
  PodDisruptionBudget:    shield,
};
