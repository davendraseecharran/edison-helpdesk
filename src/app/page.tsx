import { redirect } from 'next/navigation';

/**
 * The public surface of the application is the sign-in screen only, matching the
 * plan's requirement that nothing operational is reachable before sign-in.
 */
export default function HomePage() {
  redirect('/login');
}
