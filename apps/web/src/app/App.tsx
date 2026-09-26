import { createBrowserRouter, Link, RouterProvider } from 'react-router';
import { AppShell } from '../components/layout/AppShell';
import { AlbumPage } from '../pages/AlbumPage';
import { AlbumsPage } from '../pages/AlbumsPage';
import { AllPhotosPage } from '../pages/AllPhotosPage';
import { HomePage } from '../pages/HomePage';
import { PhotoDetailPage } from '../pages/PhotoDetailPage';
import { SettingsPage } from '../pages/SettingsPage';
import { Providers } from './providers';

function NotFound() {
  return (
    <>
      <h1>Page not found</h1>
      <Link to="/">Go to Home</Link>
    </>
  );
}

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/photos', element: <AllPhotosPage /> },
      { path: '/photos/:id', element: <PhotoDetailPage /> },
      { path: '/albums', element: <AlbumsPage /> },
      { path: '/albums/:id', element: <AlbumPage /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

export function App() {
  return (
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  );
}
