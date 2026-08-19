import React, { useState, useEffect, useCallback } from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { client } from "./core/client";
import { useMusterStore } from "./core/store";
import { useEventStream } from "./hooks/useEventStream";
import { PairingScreen } from "./screens/PairingScreen";
import { ChatListScreen } from "./screens/ChatListScreen";
import { ChatViewScreen } from "./screens/ChatViewScreen";

type RootStackParamList = {
  Pairing: undefined;
  ChatList: undefined;
  ChatView: { roomId: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

function AppContent() {
  const [isPaired, setIsPaired] = useState<boolean | null>(null);
  const {
    state,
    setConnection,
    loadRooms,
    loadBots,
    loadMessages,
    sendMessage,
    loadApprovals,
    approve,
    deny,
    answerQuestion,
    selectRoom,
    handleEvent,
  } = useMusterStore();

  // Check for existing credentials
  useEffect(() => {
    client.loadCredentials().then((hasCredentials) => {
      setIsPaired(hasCredentials);
      if (hasCredentials) {
        client.healthCheck().then((ok) => {
          if (ok) {
            loadRooms();
            loadBots();
            loadApprovals();
          } else {
            setConnection({ status: "error", error: "Computer not reachable" });
          }
        });
      }
    });
  }, []);

  // Event stream
  useEventStream({
    onEvent: handleEvent,
    onConnectionChange: setConnection,
    enabled: isPaired === true,
  });

  const handlePaired = useCallback(() => {
    setIsPaired(true);
    loadRooms();
    loadBots();
    loadApprovals();
  }, [loadRooms, loadBots, loadApprovals]);

  const handleSelectRoom = useCallback(
    (roomId: string) => {
      selectRoom(roomId);
      loadMessages(roomId);
    },
    [selectRoom, loadMessages]
  );

  const handleRefresh = useCallback(() => {
    loadRooms();
    loadBots();
    loadApprovals();
  }, [loadRooms, loadBots, loadApprovals]);

  // Loading state
  if (isPaired === null) {
    return (
      <></>
    );
  }

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      {!isPaired ? (
        <Stack.Screen name="Pairing">
          {() => <PairingScreen onPaired={handlePaired} />}
        </Stack.Screen>
      ) : (
        <>
          <Stack.Screen name="ChatList">
            {() => (
              <ChatListScreen
                rooms={state.rooms}
                bots={state.bots}
                onSelectRoom={handleSelectRoom}
                onRefresh={handleRefresh}
                refreshing={state.connection.status === "connecting"}
              />
            )}
          </Stack.Screen>
          <Stack.Screen name="ChatView">
            {({ route }) => (
              <ChatViewScreen
                roomId={route.params.roomId}
                messages={state.messages[route.params.roomId] || []}
                approvals={state.approvals}
                onSendMessage={(content) =>
                  sendMessage(route.params.roomId, content)
                }
                onApprove={approve}
                onDeny={deny}
                onAnswer={answerQuestion}
                onBack={() => selectRoom(null)}
              />
            )}
          </Stack.Screen>
        </>
      )}
    </Stack.Navigator>
  );
}

export default function App() {
  return (
    <NavigationContainer>
      <AppContent />
    </NavigationContainer>
  );
}
