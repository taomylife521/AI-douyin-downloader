import { create } from 'zustand'

interface AppState {
  loggedIn: boolean
  setLoggedIn: (v: boolean) => void
  activeJobId: string | null
  setActiveJobId: (id: string | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  loggedIn: false,
  setLoggedIn: (v) => set({ loggedIn: v }),
  activeJobId: null,
  setActiveJobId: (id) => set({ activeJobId: id }),
}))
