Name: codegraph-host-path-helper
Version: %{?version}%{!?version:0.1.0}
Release: 1%{?dist}
Summary: Privilege-separated snapshot-only HostPath helper for CodeGraph
License: Apache-2.0
Requires: systemd

%description
Independent Unix-socket helper for btrfs, ZFS and LVM read-only snapshot views.
The package never grants CAP_SYS_ADMIN to Node.js and does not install setuid files.

%files
/usr/libexec/codegraph-host-path-bridge
/usr/libexec/codegraph-host-path-daemon
/usr/lib/systemd/system/codegraph-host-path-helper.service
/usr/lib/systemd/system/codegraph-host-path-helper.socket
/usr/lib/sysusers.d/codegraph-host-path-helper.conf
/usr/lib/tmpfiles.d/codegraph-host-path-helper.conf
/usr/share/codegraph-host-path/release.pub
/usr/share/codegraph-host-path/provenance.json
