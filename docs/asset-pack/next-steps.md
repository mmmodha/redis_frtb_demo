# Next Steps — Tier-1 bank FRTB-SA on Redis Enterprise

After today's demo, the recommended path to value.

## 1. Two-week scoped POC

- Pick one risk class (suggested: GIRR Delta) and one desk.
- The bank supplies one day of real sensitivities (anonymised if needed) plus the desk's incumbent SBM oracle output.
- Redis SA + Professional Services co-builds the schema YAML and the Function library binding.
- Acceptance: live calc reproduces the incumbent oracle to within 0.01% over the sample, sub-2-second wall-clock.

## 2. Redis Enterprise Software install path

- **K8s Operator** (preferred for GKE / EKS / OpenShift) — official Operator + BDB CRDs, GitOps-native.
- **Ansible roles** for VM-based (on-prem VMware, bare metal). Same product, same modules.
- All installs run **inside the bank's perimeter**. No data egress. No SaaS dependency.

## 3. Procurement contacts

- Account executive: introduced after the demo.
- Solutions architect (technical owner of the POC): same SA who delivered the demo.
- Professional Services: scoped per-engagement for the Auto Tiering sizing, the Active-Active geo topology, and the K8s Operator install.

## 4. Sizing follow-up

- Use the [sizing worksheet](talking-points.md) to scope: rows × dimensions → memory → shards × tier mix → Redis Cloud SKU comparable.
- Three example sizings (10M / 45M / 450M) are pre-worked in the worksheet.

## 5. Timeline to production

| Phase | Duration | Output |
|---|---|---|
| Scoped POC | 2 weeks | One risk class, one desk, oracle-validated |
| Pilot | 4 weeks | GIRR + Equity + FX, multi-desk, perf-validated |
| Production | 8 weeks | K8s Operator install, full FRTB-SA scope, Auto Tiering, optional Active-Active |
| Active-Active geo | +4 weeks (parallel) | London + HK + NYC local-write topology |

Total realistic timeline from POC kick-off to production cut-over: **14–18 weeks**.
