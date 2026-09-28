<template>
  <router-view v-if="route.meta.standingDisplay" />
  <App v-else />
</template>
<script setup>
import { useRoute } from 'vue-router'
import App from './App.vue'
const route = useRoute()
</script>
