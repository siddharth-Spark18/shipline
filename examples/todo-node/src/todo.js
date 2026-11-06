// A tiny in-memory todo list.

export function createTodoList() {
  const items = [];
  let nextId = 1;

  return {
    // Adds a todo and returns it. The title can't be empty.
    add(title) {
      const text = String(title ?? '').trim();
      if (!text) throw new Error('A todo needs a title.');
      const item = { id: nextId++, title: text, done: false };
      items.push(item);
      return { ...item };
    },

    // Marks a todo done. Returns false when there is no todo with that id.
    complete(id) {
      const item = items.find((i) => i.id === id);
      if (!item) return false;
      item.done = true;
      return true;
    },

    // The todos, oldest first. { done: false } lists only the open ones.
    list({ done } = {}) {
      return items.filter((i) => done === undefined || i.done === done).map((i) => ({ ...i }));
    },
  };
}
