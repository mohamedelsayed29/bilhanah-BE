import { createBrowserRouter } from 'react-router';
import { SiteLayout } from './SiteLayout';
import { HomePage } from '../features/marketing/pages/HomePage';
import { AboutPage } from '../features/marketing/pages/AboutPage';
import { ContactPage } from '../features/marketing/pages/ContactPage';
import { LegalPage } from '../features/marketing/pages/LegalPage';
import { NotFoundPage } from '../features/marketing/pages/NotFoundPage';

export const router = createBrowserRouter([
  {
    element: <SiteLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'about', element: <AboutPage /> },
      { path: 'contact', element: <ContactPage /> },
      { path: 'shop', lazy: async () => { const { ShopPage } = await import('../features/stand-shop/ShopPage'); return { Component: ShopPage }; } },
      { path: 'privacy', element: <LegalPage document="privacy" /> },
      { path: 'terms', element: <LegalPage document="terms" /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
