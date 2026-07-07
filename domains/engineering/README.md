# Domain: Engineering

The engineering design companion: a review and reasoning partner for design engineers, systems architects, and safety reviewers. It checks designs against standards, remembers why past decisions were made, and catches the failure mode every team fears: repeating a mistake the organization already paid to learn.

## Who it serves

- Design engineers iterating against standards and internal design rules
- Review boards running structured design reviews with traceable rationale
- New team members inheriting systems whose design history lives in departed heads

## What makes this domain distinctive

- The subject is a *project or system*, with a decision log as its memory backbone
- Institutional memory is the killer feature: corrections encode organizational scar tissue
- Standards compliance is a constraints problem, mapping directly onto reasoning `constraints`
- Vision matters: schematics, CAD exports, and datasheets are primary inputs

## Safety posture

- Advises and checks; never signs off. Formal design approval is a human act (charter refusal)
- Standards versions are pinned per project; the knowledge contract's `asOf` prevents silent drift
- Any tool that mutates the design repository or issues change orders is `write`/`critical` class

## Start here

- Interfaces to bind: [`interfaces.md`](interfaces.md)
- Memory semantics: [`memory.md`](memory.md)
- Tool pack: [`tools.md`](tools.md)
- Review workflows: [`workflows.md`](workflows.md)
