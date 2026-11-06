import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTodoList } from '../src/todo.js';

test('add returns the new todo, open by default', () => {
  const todos = createTodoList();
  assert.deepEqual(todos.add('Write docs'), { id: 1, title: 'Write docs', done: false });
});

test('add rejects an empty title', () => {
  const todos = createTodoList();
  assert.throws(() => todos.add('   '), /needs a title/);
});

test('complete marks a todo done, and reports an unknown id', () => {
  const todos = createTodoList();
  const { id } = todos.add('Ship it');
  assert.equal(todos.complete(id), true);
  assert.equal(todos.complete(99), false);
  assert.equal(todos.list()[0].done, true);
});

test('list can show only the open todos', () => {
  const todos = createTodoList();
  const a = todos.add('A');
  todos.add('B');
  todos.complete(a.id);
  assert.deepEqual(todos.list({ done: false }).map((t) => t.title), ['B']);
});
