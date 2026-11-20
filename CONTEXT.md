# Personal Memory

A person's remembered information about their life and the people, places, and experiences connected to it.

## Language

**Vault Owner**:
The user whose private memories belong to a Memory Vault.
_Avoid_: Family administrator, subject

**Memory Vault**:
A private collection of memories owned by one user across their authorized agents.
_Avoid_: Household vault, family account

**Entity**:
A distinct person, place, organization, event, or other thing referred to by memories.

**Subject**:
An Entity, including the Vault Owner or another person, described by remembered information.
_Avoid_: User, account holder

**Source Evidence**:
User-supplied content and its context supporting a Remembered Claim.
_Avoid_: Verified fact

**Source Statement**:
The original wording supplied with a request to remember information.

**Remembered Claim**:
An assertion retained in a Memory Vault with supporting Source Evidence.
_Avoid_: Verified fact, model guess

**Life Event**:
An occurrence in a Subject's life that may change what is true about them over time.
_Avoid_: Current state

**Correction**:
A revision identifying a previously Remembered Claim as mistaken and recording its replacement when supplied.
_Avoid_: Life Event

**Revision History**:
The retained record of earlier Remembered Claims, their evidence, and Corrections.
_Avoid_: Previously true facts

**Correction Lineage**:
An original Remembered Claim and the assertions that correct it.

**Forgetting**:
The removal of targeted remembered information, including its corrected versions and supporting content.
_Avoid_: Hiding, Correction

**Memory Level**:
A degree of detail in a view of remembered information, independent of its validity and retention.
_Avoid_: Expiration tier

**Overview (L0)**:
A compact view of the Vault Owner's life context.

**Domain Context (L1)**:
A view of relevant remembered detail within an area of the Vault Owner's life.

**Detailed Record (L2)**:
Precise remembered information with its evidence and history for reuse.

**Form Session**:
A form-filling activity whose captured entries and revisions are retained together.

**Captured Field**:
An entered value together with its field meaning, subject, and form context within a Form Session.

**Form Finalization**:
The Vault Owner's indication that a form's completed answers are final and ready for reuse.
_Avoid_: Submission

**Change Proposal**:
A description of a specific change to existing remembered information awaiting the Vault Owner's approval.

**Change Approval**:
The Vault Owner's explicit permission, conveyed through the calling agent's chat, to apply a specific Change Proposal.
_Avoid_: General client access

## Relationships

- Each **Memory Vault** belongs to exactly one **Vault Owner**.
- Each **Memory Vault** may describe many **Subjects**.
- A **Subject** may be described independently in different **Memory Vaults**.
- A **Subject** gains no access to a **Memory Vault** through family membership or being described in it.
- A **Source Statement** may describe one or more **Life Events**.
- Each **Remembered Claim** is supported by one or more pieces of **Source Evidence**.
- A **Source Statement** may support multiple **Remembered Claims**.
- **Source Statements** and user-supplied **Captured Fields** are forms of **Source Evidence**.
- A **Form Session** contains zero or more **Captured Fields** and retains their revisions.
- **Form Finalization** makes supported facts from a **Form Session** eligible for reusable memory without requiring successful submission.
- A **Correction** retains the mistaken **Remembered Claim** and its evidence in **Revision History**.
- A **Correction** stays within the same **Correction Lineage**; a genuine change over time starts a separate assertion about the new period.
- Applying a **Correction** or **Forgetting** requires a **Change Approval** from the **Vault Owner**.
- A **Change Proposal** does not establish new remembered facts before approval.
- **Forgetting** removes the targeted content from a **Memory Vault**, including relevant **Revision History**, while preserving unrelated memories.
- **Overview (L0)**, **Domain Context (L1)**, and **Detailed Record (L2)** are views of the same underlying memories.

## Example dialogue

> **Dev:** "If a Vault Owner remembers their spouse's birthday, can the spouse access that Memory Vault?"
> **Domain expert:** "No. The spouse is a Subject of that memory; they do not gain access to the owner's private memories."

> **Dev:** "When a Subject moves, does remembering their new residence erase the previous one?"
> **Domain expert:** "No. The move is a Life Event; the previous residence remains part of their history."

> **Dev:** "If a birthday is corrected, was the earlier date once the Subject's birthday?"
> **Domain expert:** "No. Revision History records the earlier mistake; ordinary answers use the corrected claim."

> **Dev:** "Can a forgotten birthday be recovered by asking for Revision History?"
> **Domain expert:** "No. Forgetting removes its current and corrected versions and their supporting content."

## Flagged ambiguities

- "User" could mean the person owning memories or someone described in them; these are distinct roles: **Vault Owner** and **Subject**.
- A family describes relationships between **Subjects**, not a shared ownership or access boundary; household sharing is outside the initial scope.
- A **Remembered Claim** records information supported by **Source Evidence**; support does not establish independent verification of its truth.
- "Medium term" describes contextual relevance in **Domain Context (L1)**, not an automatic expiration rule; **Memory Level**, validity, and retention are separate concepts.
- A field value is interpreted with its form context; "desired salary" and "current salary" express different claims even when their entered amounts match.
- Finalizing a form establishes that its answers are ready for reuse; it does not establish that the destination has received or accepted the form.
- Permission to connect an agent is distinct from **Change Approval** for a particular edit or deletion.
- A direct user instruction counts as **Change Approval** when it fully specifies the target and changes; inferred or broader changes require a preview and confirmation.
