import { lazy } from 'react';
import { createBrowserRouter } from 'react-router-dom';
export const router=createBrowserRouter([
  {path:'/',Component:lazy(()=>import('./pages/HomePage'))},
  {path:'/token/:address',Component:lazy(()=>import('./pages/TokenPage'))},
  {path:'/terms',Component:lazy(()=>import('./pages/TermsPage'))},
  {path:'*',Component:lazy(()=>import('./pages/NotFoundPage'))}
]);
