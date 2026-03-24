export const KINDS = {
  Ingress:                { color: "#A855F7", tag: "ING" },
  Service:                { color: "#22C55E", tag: "SVC" },
  Deployment:             { color: "#3B82F6", tag: "DEP" },
  StatefulSet:            { color: "#F97316", tag: "STS" },
  DaemonSet:              { color: "#EF4444", tag: "DS"  },
  ReplicaSet:             { color: "#60A5FA", tag: "RS"  },
  Pod:                    { color: "#64748B", tag: "POD" },
  Node:                   { color: "#0EA5E9", tag: "NOD" },
  AzureService:           { color: "#2563EB", tag: "AZR" },
  ConfigMap:              { color: "#EAB308", tag: "CM"  },
  Secret:                 { color: "#94A3B8", tag: "SEC" },
  PersistentVolumeClaim:  { color: "#14B8A6", tag: "PVC" },
  Job:                    { color: "#8B5CF6", tag: "JOB" },
  CronJob:                { color: "#EC4899", tag: "CJ"  },
  HorizontalPodAutoscaler:{ color: "#06B6D4", tag: "HPA" },
  PodDisruptionBudget:    { color: "#F43F5E", tag: "PDB" },
  NetworkPolicy:          { color: "#84CC16", tag: "NP"  },
};

export const EDGE_COLORS = {
  routes:   "#A855F7",
  selects:  "#22C55E",
  owns:     "#3B82F6",
  uses:     "#EAB308",
  calls:    "#F97316",
  scales:   "#06B6D4",
  disrupts: "#F43F5E",
  policies: "#84CC16",
  hosts:    "#0EA5E9",
  azure:    "#2563EB",
};

export const EDGE_LEGEND_TR = {
  routes:   "Ingress\u2192Svc",
  selects:  "Service\u2192Pod",
  owns:     "Controller\u2192Pod",
  uses:     "Volume/Env",
  calls:    "App \u00e7a\u011fr\u0131s\u0131",
  scales:   "HPA \u00f6l\u00e7ekleme",
  disrupts: "PDB koruma",
  policies: "NetworkPolicy\u2192Pod",
  hosts:    "Node\u2192Pod",
  azure:    "Azure ba\u011f\u0131ml\u0131l\u0131\u011f\u0131",
};

export const HEALTH_COLORS = {
  critical: "#EF4444",
  warning:  "#F59E0B",
  info:     "#60A5FA",
  ok:       "#22C55E",
};

export const NW = 172;
export const NH = 66;

export const KUBECTL_PLURAL = {
  Pod: "pods",
  Service: "services",
  Deployment: "deployments",
  StatefulSet: "statefulsets",
  DaemonSet: "daemonsets",
  ReplicaSet: "replicasets",
  Ingress: "ingresses",
  ConfigMap: "configmaps",
  Secret: "secrets",
  PersistentVolumeClaim: "persistentvolumeclaims",
  Job: "jobs",
  CronJob: "cronjobs",
  HorizontalPodAutoscaler: "horizontalpodautoscalers",
  PodDisruptionBudget: "poddisruptionbudgets",
  NetworkPolicy: "networkpolicies",
  Node: "nodes",
};
