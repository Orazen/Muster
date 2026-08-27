# Memory Store

Core memory management system for Muster+

## Memory Types

1. **Episodic** - Conversation history and events
2. **Semantic** - Facts and knowledge
3. **Procedural** - Task patterns and workflows
3. **Emotional** - User preferences and mood
4. **Prospective** - Future plans and goals
5. **Behavioral** - User behavior patterns
6. **Narrative** - Personal narrative and context
7. **Shared** - Shared team knowledge
8. **Temporal** - Time-based events

## Memory Operations

### Storage
- Uses SQLCipher (encrypted SQLite)
- Each memory type has dedicated tables
- Row-level locking for concurrent access

### Operations
- `get(key: string): MemoryItem | null`
- `set(key: string, value: any): boolean`
- `delete(key: string): boolean`
- `list(): Record<string, any>`
- `clear(): boolean`
- `export(): JSON`
- `import(data: JSON): void`

### Memory Types

#### Episodic Memory
- Stores conversation history
- Includes timestamps, user/bot identifiers
- Supports filtering by time range

### Semantic Memory
- Stores facts and knowledge
- Uses vector embeddings for retrieval
- Supports semantic search

### Procedural Memory
- Stores task patterns and workflows
- Supports execution triggers
- Can be invoked by user actions

### Emotional Memory
- Stores user preferences and mood states
- Tracks emotional responses to interactions
- Supports mood-based agent behavior

### Prospective Memory
- Stores future plans and intentions
- Supports time-based triggers
- Integrates with calendar systems

### Behavioral Memory
- Tracks user behavior patterns
- Supports predictive modeling
- Used for personalized recommendations

### Narrative Memory
- Stores personal narrative and context
- Helps build consistent identity
- Supports storytelling features

### Shared Memory
- Stores team or group knowledge
- Supports collaborative memory
- Integrates with team management

### Memory Management
- Automatic cleanup of old/unused items
- Memory health monitoring
- Storage optimization
- Memory backup/restore functionality
