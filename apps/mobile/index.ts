// Ponto de entrada. Os polyfills precisam ser carregados antes de qualquer
// outro módulo: a criptografia usa crypto.getRandomValues.
import 'react-native-get-random-values';
import 'expo-router/entry';
