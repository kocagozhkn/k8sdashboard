{{- define "mcm-hub.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "mcm-hub.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "mcm-hub.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end }}
