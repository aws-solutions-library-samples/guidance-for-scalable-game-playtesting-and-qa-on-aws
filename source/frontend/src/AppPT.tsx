import '@aws-amplify/ui-react/styles.css';

//import './App.css';

import { Authenticator } from '@aws-amplify/ui-react';

import ApplicationPT from "./components/ApplicationPT";

export default function AppPT() {
    return (
        <Authenticator hideSignUp={true}>
            {({ signOut, user }) => (
                <ApplicationPT signOut={signOut}></ApplicationPT>
            )}
        </Authenticator>
    );
}