# app.bsky.feed.like

> Record declaring a 'like' of a piece of subject content.

- Kind: record
- Record key: tid
- Authority: feed.bsky.app
- Lexicon: 1
- Published by [bsky-lexicons.bsky.social](https://lexicon.garden/identity/did:plc:4v4y5r3lwsbtmsxhile2ljac), the NSID's authority

## Links

- [Documentation](https://lexicon.garden/lexicon/did:plc:4v4y5r3lwsbtmsxhile2ljac/app.bsky.feed.like)
- [Schema JSON](https://lexicon.garden/lexicon/did:plc:4v4y5r3lwsbtmsxhile2ljac/app.bsky.feed.like/schema.json)
- [Analytics](https://lexicon.garden/lexicon/did:plc:4v4y5r3lwsbtmsxhile2ljac/app.bsky.feed.like/analytics)

## Record (`app.bsky.feed.like`)

Type: record · key tid

### Properties

- `createdAt` (string · datetime, required)
- `subject` (ref, required)
  - Reference: `com.atproto.repo.strongRef`
- `via` (ref)
  - Reference: `com.atproto.repo.strongRef`

## Schema

```json
{
  "$type": "com.atproto.lexicon.schema",
  "defs": {
    "main": {
      "description": "Record declaring a 'like' of a piece of subject content.",
      "key": "tid",
      "record": {
        "properties": {
          "createdAt": {
            "format": "datetime",
            "type": "string"
          },
          "subject": {
            "ref": "com.atproto.repo.strongRef",
            "type": "ref"
          },
          "via": {
            "ref": "com.atproto.repo.strongRef",
            "type": "ref"
          }
        },
        "required": [
          "subject",
          "createdAt"
        ],
        "type": "object"
      },
      "type": "record"
    }
  },
  "id": "app.bsky.feed.like",
  "lexicon": 1
}
```
