# ADR-014: Deterministic, grounded recommendations

**Status:** Accepted

## Context

The obvious build for an "AI API finder" is to send the catalogue to a language model and render
whatever comes back. It demos well and is unusable in practice: the model invents endpoints,
misstates authentication, and fabricates pricing.

Report section 26.1 is explicit. AI must be an augmentation, grounded in structured metadata, and
must not invent endpoints, prices or authentication requirements.

## Decision

The recommendation pipeline is **fully deterministic**:

```
prompt -> intent extraction -> structured filters -> indexed retrieval
       -> weighted scoring -> reasons and caveats read off real columns
```

Every reason shown is generated *from* a catalogue field ("No authentication needed", "99.8% uptime
over 30 days"), so it cannot be a hallucination. Every recommendation also lists **caveats**:
required OAuth, missing CORS, currently failing health.

The inferred constraints are shown back to the user, so they can see that "no auth" became a filter
and correct it if the inference was wrong.

An LLM may later add a narrative summary. It will never choose the APIs or describe their
capabilities.

## Consequences

**Good.** Recommendations are reproducible, explainable and fast, with no model call. The feature
works with no API key configured. Nothing can be fabricated because nothing is generated.

**Bad.** Intent extraction is a curated keyword map, so genuinely novel phrasings fall back to
lexical search. Less impressive than a chat interface.

**Trade accepted.** A recommendation a developer can verify is worth more than one that sounds
better.

## Revisit when

Embeddings are available. They would improve *retrieval* (finding candidates), while scoring and
explanation stay deterministic.
