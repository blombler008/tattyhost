'use server';

let count: number = 0;

export async function incrementCount() {
  'use server';
  setAppCount(count + 1);
  return count;
}

export async function setAppCount(newCount: number) {
  console.log("setCount", newCount);
  count = newCount;
}

export function getAppCount() {
  return count;
}