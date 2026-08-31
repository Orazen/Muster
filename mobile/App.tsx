/**
 * Muster+ Mobile App
 */
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export default function App() {
  return (
    <>
      <StatusBar style="light" />
      <Stack screenOptions={{
        headerStyle: { backgroundColor: '#030711' },
        headerTintColor: '#ffffff',
        contentStyle: { backgroundColor: '#030711' },
      }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      </Stack>
    </>
  );
}
