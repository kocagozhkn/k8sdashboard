# gRPC / Protobuf (next step)

Define `ClusterService` RPCs mirroring REST:

- `RegisterCluster`, `GetCluster`, `ListClusters`, `PatchCluster`, `DeleteCluster`, `Heartbeat`

Generate with `buf` or `protoc` into `gen/go/` and add a second listener in `cluster-service` (e.g. `:9090` gRPC + `:8081` REST).
