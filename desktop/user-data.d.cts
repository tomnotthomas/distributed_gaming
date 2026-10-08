// Types for user-data.cjs, so its tests can use it.

export type UserData = { dir: string; old: string };

export const KEPT: string[];
export function userDataOf(appData: string): UserData;
export function moveUserData(where: UserData, files?: typeof import("node:fs")): boolean;
