import { StrictMode } from 'react'
import { hydrateRoot } from 'react-dom/client'
import './index.css'
import App from './App' 
import { SSRAuthState } from './middleware/check-auth'

function getProps<T = any>(propName: string): T | null {
    const el = document.getElementById(propName);
    if (!el) return null;

    try {
        return JSON.parse(el.textContent || '{}') as T;
    } catch {
        return null;
    }
}

const ssrAuth: SSRAuthState = getProps<SSRAuthState>('ssr-auth')!;

hydrateRoot(
    document.getElementById('root') as HTMLElement,
    <StrictMode>
        <App ssrAuth={ssrAuth} pathname={window.location.pathname}>
            
        </App>
    </StrictMode>,
)