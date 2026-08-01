# Linux HostPath snapshot helper

该包只交付 btrfs 单 subvolume、ZFS 单 dataset、LVM 单 thin origin LV 的只读 snapshot view 核心。
ext4/xfs freeze、root filesystem freeze、overlayfs、网络文件系统、FUSE、未知文件系统及
rootless/overlay container 均继续 fail closed。

btrfs 会在 daemon 的私有 mount namespace 内把同一 filesystem 的 top-level subvolume
挂到 helper 自有 `/run` 目录，再创建只读 snapshot，避免跨文件系统 snapshot 目标。
LVM 仅接受已绑定 VG/LV UUID 的 thin origin；ext4 使用 `ro,noload`，XFS 使用
`ro,norecovery,nouuid`，并在固定 batch 前后检查 thin pool 与 snapshot 健康状态。

Node 主进程只打开 indexing root 目录并把真实 FD 继承给无特权 bridge。bridge 再通过
`SCM_RIGHTS` 把 FD 交给独立 systemd daemon；只有 daemon 的 capability bounding set 包含
`CAP_SYS_ADMIN`。安装器必须生成 32 字节 client key、安装 Ed25519 公钥与签名 provenance，
并按 `install-layout.v1.json` 设置所有权和权限。provenance schema v2 分别签名 bridge 与
daemon 的 SHA-256；两个进程都从 `/proc/self/exe` 打开的当前执行文件对象重算摘要，避免仅
依赖可替换路径字符串。仓库测试和 CI 不执行真实 snapshot、mount、systemd 安装或提权。
