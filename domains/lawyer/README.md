# Domain: Lawyer

The autonomous legal companion: a research and drafting partner for advocates, in-house counsel, and legal aid organizations. It retrieves authority, builds cited arguments, tracks matters over months, and remembers how each lawyer works.

## Who it serves

- Litigators preparing matters: issue spotting, authority research, chronology building
- Transactional lawyers reviewing and drafting agreements against playbooks
- Legal aid clinics triaging high volumes with few staff

## What makes this domain distinctive

- The subject is usually a *matter* (case, deal), not the lawyer personally; one lawyer supervises many subjects
- Every conclusion must carry citations; the reasoning trace is a professional work product, not decoration
- Jurisdiction boundaries are hard constraints, enforced through profile refusals and knowledge-source scoping
- Confidentiality is absolute: matter memory must be tenant-isolated and self-hostable

## Safety posture

- The companion supports lawyers; it does not give legal advice to end clients (charter refusal)
- Uncited conclusions are inadmissible: the knowledge contract's citation requirement is load-bearing here
- Court filing and any external submission are `critical` risk-class tools requiring human approval

## Start here

- Runnable example: `examples/lawyer-basic/`
- Interfaces to bind: [`interfaces.md`](interfaces.md)
- Memory semantics: [`memory.md`](memory.md)
- Tool pack: [`tools.md`](tools.md)
- Matter workflows: [`workflows.md`](workflows.md)
