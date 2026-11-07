const installer = import.meta.env.PUBLIC_WINDOWS_INSTALLER_URL?.trim()
  || 'https://ae5rkunkhbjgx5zz.public.blob.vercel-storage.com/windows/v0.1.1/Kaji-0.1.1-x64-setup.exe';
if (installer && !/^https:\/\/[^\s]+\.(?:exe|msi)(?:\?[^\s]*)?$/i.test(installer)) {
  throw new Error('PUBLIC_WINDOWS_INSTALLER_URL must be an HTTPS .exe or .msi URL.');
}

export const site = {
  name: 'Kaji',
  description: 'An on-screen companion that points, assists, and clicks for you. Explore a more flexible way to navigate Windows.',
  github: 'https://github.com/justhenix/kaji',
  releases: 'https://github.com/justhenix/kaji/releases',
  installer: installer || null,
};
